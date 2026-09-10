// ---- module runtime + shims ----

// A minimal CommonJS-lite module system. Modules register themselves with
// defineModule(key, factory); factory runs lazily, once, the first time
// something require()s that key -- same semantics as Node's require cache,
// which is all the vendored code actually needs (it was written as real ES
// modules, so import order across files was never something it relied on).
var __modules = Object.create(null);
var __cache = Object.create(null);
var __loading = Object.create(null);

function defineModule(key, factory) {
    __modules[key] = factory;
}

function require(key) {
    if (__cache[key]) return __cache[key].exports;

    var factory = __modules[key];
    if (!factory) {
        throw new Error("[Instafn] require(\"" + key + "\"): no such module registered");
    }
    if (__loading[key]) {
        // Circular require: hand back the in-progress (possibly incomplete)
        // exports object rather than looping forever. None of the vendored
        // modules are circular in practice, but this keeps a future one from
        // hanging the whole page instead of just being wrong.
        return __loading[key].exports;
    }

    var module = { exports: {} };
    __loading[key] = module;
    factory(module, module.exports, require);
    delete __loading[key];
    __cache[key] = module;
    return module.exports;
}

// Page-context scripts (not ES modules -- see toPageScript in transform.js)
// live in a separate registry, since they're invoked directly against
// unsafeWindow rather than require()'d.
var PAGE_SCRIPTS = Object.create(null);

// Embedded CSS text, keyed the same way as the vendor tree. Populated by
// transform.js; consumed by the injectStylesheet() shim below.
var STYLE_SOURCES = Object.create(null);


// ---------------------------------------------------------------------
// chrome.* shim
//
// Every vendored feature file still says `chrome.storage.sync.get(...)`,
// `chrome.runtime.sendMessage(...)`, etc. -- completely unmodified from the
// upstream extension. We don't touch that code at all; instead we declare a
// local `chrome` inside this same closure that shadows whatever `window.
// chrome` may or may not exist (Firefox has none, Chrome's real one is a
// different, unrelated object) and backs the same call shapes with GM_*
// storage. Every vendored module resolves the bare identifier `chrome` to
// this one, because they're all concatenated into one function scope.
// ---------------------------------------------------------------------

var __onChangedListeners = [];

function __gmGet(key, fallback) {
    try {
        var v = GM_getValue(key);
        return v === undefined ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function __gmSet(key, value) {
    GM_setValue(key, value);
}

// Shared by chrome.storage.sync.get and chrome.storage.local.get. `query` is
// either an array of keys (no defaults -- missing keys are simply absent
// from the result, matching chrome.storage semantics), a single string key,
// or an object mapping key -> default value.
function __storageGet(query, callback) {
    var result = {};
    if (Array.isArray(query)) {
        for (var i = 0; i < query.length; i++) {
            var k = query[i];
            var v = __gmGet(k, undefined);
            if (v !== undefined) result[k] = v;
        }
    } else if (typeof query === "string") {
        var sv = __gmGet(query, undefined);
        if (sv !== undefined) result[query] = sv;
    } else if (query && typeof query === "object") {
        for (var key in query) {
            if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
            result[key] = __gmGet(key, query[key]);
        }
    }
    // chrome.storage callbacks are technically async; a microtask keeps that
    // contract without actually costing anything (GM_getValue is sync).
    Promise.resolve().then(function () { callback(result); });
}

function __storageSet(items, callback) {
    var changes = {};
    for (var key in items) {
        if (!Object.prototype.hasOwnProperty.call(items, key)) continue;
        var oldValue = __gmGet(key, undefined);
        var newValue = items[key];
        __gmSet(key, newValue);
        changes[key] = { oldValue: oldValue, newValue: newValue };
    }
    Promise.resolve().then(function () {
        if (callback) callback();
        for (var i = 0; i < __onChangedListeners.length; i++) {
            try { __onChangedListeners[i](changes, "sync"); } catch (e) { console.error("[Instafn] onChanged listener threw:", e); }
        }
    });
}

// ---- downloads bridge --------------------------------------------------
// Upstream: content script -> chrome.runtime.sendMessage -> background
// service worker -> chrome.downloads.download (bypasses CORS on
// cdninstagram/fbcdn because the browser fetches it, not the page). A
// userscript has no service worker, but GM_download does the exact same
// job -- it's a manager-side fetch + save, not a page fetch, so it doesn't
// touch CORS either.
function __performDownload(msg, sendResponse) {
    if (typeof GM_download !== "function") {
        sendResponse({ ok: false, error: "GM_download is not available (grant missing?)" });
        return;
    }
    try {
        GM_download({
            url: msg.url,
            name: msg.filename || undefined,
            saveAs: !!msg.saveAs,
            onload: function () { sendResponse({ ok: true }); },
            onerror: function (err) {
                sendResponse({ ok: false, error: (err && (err.error || err.details || err.message)) || "download failed" });
            },
            ontimeout: function () { sendResponse({ ok: false, error: "download timed out" }); }
        });
    } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
}

var chrome = {
    storage: {
        sync: {
            get: function (query, callback) { __storageGet(query, callback); },
            set: function (items, callback) { __storageSet(items, callback); }
        },
        local: {
            get: function (query, callback) { __storageGet(query, callback); },
            set: function (items, callback) { __storageSet(items, callback); }
        },
        onChanged: {
            addListener: function (fn) { __onChangedListeners.push(fn); }
        }
    },
    runtime: {
        getURL: function (path) {
            // Only utils/scriptInjector.js and utils/styleLoader.js ever called
            // this upstream, and both of those vendored files are swapped out
            // for userscript-native replacements below (see
            // shim/02-page-inject.js) that never call getURL at all. Anything
            // else hitting this is new/unexpected -- fail loudly instead of
            // silently returning a dead chrome-extension:// URL.
            console.warn("[Instafn] chrome.runtime.getURL() called for", path, "-- this has no userscript equivalent");
            return path;
        },
        getManifest: function () {
            var version = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0.0.0";
            return { version: version };
        },
        sendMessage: function (message, callback) {
            if (message && message.type === "INSTAFN_DOWNLOAD") {
                __performDownload(message, callback || function () {});
                return;
            }
            if (callback) callback(undefined);
        },
        lastError: undefined
    },
    // The settings page originally reloaded whichever browser tab had
    // Instagram open, from a *separate* settings tab. That page is now
    // mounted as an overlay inside the Instagram tab itself (see
    // shim/03-settings-page.js), so "the active Instagram tab" is just
    // this document -- reload it directly instead of actually querying tabs
    // (a real chrome.tabs API has no userscript equivalent regardless).
    tabs: {
        query: function (_queryInfo, callback) {
            callback([{ active: true, url: location.href, id: 0 }]);
        },
        reload: function () {
            location.reload();
        },
        create: function (opts) {
            window.open(opts && opts.url, "_blank");
        }
    }
};

// ---------------------------------------------------------------------
// fetch shim for the Instagram CDN hosts
//
// The extension could fetch() cdninstagram.com/fbcdn.net/fbsbx.com straight
// from the content script without hitting CORS, because those hosts are
// listed in manifest.json's host_permissions. A userscript has no such
// grant, and a plain page fetch() to those hosts *would* hit CORS. Route
// just those hosts through GM_xmlhttpRequest (a manager-side request, not
// a page one -- CORS doesn't apply) and return a Fetch-API-shaped Response
// so the vendored code (which only ever calls .ok/.status/.arrayBuffer())
// doesn't need to change at all. Instagram's own domain still goes through
// the real fetch, unchanged, so credentials/cookies keep working normally.
// ---------------------------------------------------------------------

var __CDN_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com)$/i;
var __realFetch = window.fetch.bind(window);

function __isCdnUrl(url) {
    try {
        var host = new URL(url, location.href).hostname;
        return __CDN_HOST_RE.test(host);
    } catch (e) {
        return false;
    }
}

function __gmFetchBytes(url) {
    return new Promise(function (resolve, reject) {
        if (typeof GM_xmlhttpRequest !== "function") {
            reject(new Error("GM_xmlhttpRequest is not available (grant missing?)"));
            return;
        }
        GM_xmlhttpRequest({
            method: "GET",
            url: url,
            responseType: "arraybuffer",
            onload: function (resp) {
                if (resp.status >= 200 && resp.status < 300) {
                    resolve({ ok: true, status: resp.status, body: resp.response });
                } else {
                    resolve({ ok: false, status: resp.status, body: null });
                }
            },
            onerror: function () { reject(new Error("GM_xmlhttpRequest network error for " + url)); },
            ontimeout: function () { reject(new Error("GM_xmlhttpRequest timed out for " + url)); }
        });
    });
}

function fetch(url, opts) {
    if (typeof url === "string" && __isCdnUrl(url)) {
        return __gmFetchBytes(url).then(function (r) {
            return {
                ok: r.ok,
                status: r.status,
                arrayBuffer: function () { return Promise.resolve(r.body); },
                blob: function () { return Promise.resolve(new Blob([r.body])); }
            };
        });
    }
    return __realFetch(url, opts);
}


// ---------------------------------------------------------------------
// Page-context script runner
//
// Upstream, these 4 files (socket-sniffer, graphql-sniffer, storyblocking,
// voice-sniffer, websocket-interceptor) got injected via a <script src=
// chrome-extension://...> tag, specifically to escape the content script's
// isolated JS world and patch the *page's* window.WebSocket/fetch/etc, since
// Instagram's own scripts only see patches made to their own real window.
// Instagram's CSP blocks inline <script> tags, which is why the extension
// needed a src= URL instead of just writing the code inline.
//
// A userscript sidesteps this entirely: with @grant unsafeWindow, we already
// have a live reference to the page's real window object, and calling a
// plain JS function against it is not a script *tag* at all -- there's
// nothing for Instagram's CSP to block, because we never ask the page to
// parse or fetch anything. So instead of injecting a URL, we just call the
// vendored IIFE body directly, with its `window` parameter bound to
// unsafeWindow. The vendored source for these files is untouched (see
// PAGE_SCRIPTS_LIST in transform.js) -- every `window.WebSocket = ...`
// inside them already does exactly the right thing once `window` here means
// the real page window. The one thing that ISN'T untouched is bare global
// references these scripts make (`XMLHttpRequest.prototype.open = ...`,
// not `window.XMLHttpRequest...`) -- toPageScript() in transform.js shadows
// those identifiers with locals bound to the real window before the
// vendored src runs, since an unqualified `XMLHttpRequest`/`WebSocket`
// would otherwise resolve to the userscript sandbox's own constructor
// instead of the page's.
// ---------------------------------------------------------------------

var __realWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
var __injectedPageScripts = Object.create(null);

// ---- universal (Chrome + Firefox) page-window proxy ---------------------
//
// Chrome-based managers (Tampermonkey/Violentmonkey on Chrome) give
// unsafeWindow as a fully transparent reference to the page window --
// `unsafeWindow.WebSocket = function(){...}` just works, page scripts see
// it immediately. Firefox-based managers run userscripts in an Xray-wrapped
// sandbox for security, and a *function created in the sandbox* assigned
// directly onto unsafeWindow can misbehave in the page compartment --
// `new`-invocation and identity checks aren't guaranteed, which matters a
// lot here since these page scripts replace WebSocket/fetch constructors
// that Instagram's own code then calls with `new` or checks with
// `instanceof`. Firefox's fix for exactly this is `exportFunction`, which
// builds a proper page-compartment-native wrapper around a sandbox function.
// Chrome has no such function (and doesn't need one).
//
// Rather than editing every vendored page script to conditionally call
// exportFunction, this Proxy does it transparently: any `window.X = fn`
// a page script performs gets exported automatically on Firefox, and is a
// plain passthrough assignment on Chrome (or any manager without
// exportFunction/cloneInto). Reads and method calls (postMessage, atob,
// addEventListener, ...) are passed through with `this` bound to the real
// window, which a bare Proxy would otherwise break (native DOM methods
// reject being called with the Proxy itself as `this`).
// A small, fixed set of Window methods these 5 scripts actually call as
// `window.methodName(...)` and need a genuine Window `this` for (native DOM
// methods reject being invoked with the Proxy itself as receiver). Bound
// once per proxy and cached, rather than binding every function property on
// every read: WebSocket/fetch are themselves function-valued properties
// that get mutated after assignment (`.prototype = ...`, static props
// copied on), and a fresh `.bind()` wrapper on every `get` would silently
// break that -- each read would hand back a *new* wrapper object with none
// of the previous read's mutations on it.
var __PROXY_BOUND_METHODS = ["postMessage", "addEventListener", "removeEventListener", "dispatchEvent"];

function makePageWindowProxy(target) {
    if (typeof exportFunction !== "function" || typeof cloneInto !== "function") {
        // Chrome/Edge/etc, or a manager that doesn't need this at all.
        return target;
    }
    var boundMethods = Object.create(null);
    for (var i = 0; i < __PROXY_BOUND_METHODS.length; i++) {
        var name = __PROXY_BOUND_METHODS[i];
        if (typeof target[name] === "function") boundMethods[name] = target[name].bind(target);
    }
    return new Proxy(target, {
        get: function (t, prop, receiver) {
            if (boundMethods[prop]) return boundMethods[prop];
            return Reflect.get(t, prop, t);
        },
        set: function (t, prop, value) {
            if (typeof value === "function") {
                try {
                    value = exportFunction(value, t, { defineAs: typeof prop === "string" ? prop : undefined });
                } catch (e) {
                    console.error("[Instafn] exportFunction failed for", prop, e);
                }
            }
            return Reflect.set(t, prop, value);
        }
    });
}

function runPageScript(key) {
    if (__injectedPageScripts[key]) return true;
    var fn = PAGE_SCRIPTS[key];
    if (!fn) {
        console.error("[Instafn] runPageScript: no page script registered for", key);
        return false;
    }
    try {
        fn(makePageWindowProxy(__realWindow));
        __injectedPageScripts[key] = true;
        return true;
    } catch (err) {
        console.error("[Instafn] error running page script", key, err);
        return false;
    }
}

// ---- Xray-safe constructor wrapping (Firefox only) -----------------------
//
// makePageWindowProxy's `set` trap only fires for assignments made directly
// on the `window` object it wraps (`window.fetch = ...`). It does NOT fire
// for `XMLHttpRequest.prototype.open = ...` or `SomeCtor.prototype.x = fn`
// -- that's a property set on a *different* object (the constructor's
// prototype), two property-accesses removed from `window`, which no Proxy
// on `window` alone can see. On Chrome this is harmless (unsafeWindow is
// the real page window, so `window.XMLHttpRequest.prototype` already *is*
// the real prototype and a plain assignment just works). On Firefox,
// `window.XMLHttpRequest.prototype` is a real page-compartment object
// viewed through an Xray wrapper; assigning a sandbox-created function onto
// it as a method skips exportFunction, so the resulting property is not a
// callable a page-compartment caller can invoke correctly -- Instagram's
// own `xhr.open(...)` call silently no-ops instead of running our patch,
// which is exactly what broke DM voice-note capture (the thread loads over
// XHR, not fetch) despite XMLHttpRequest itself now correctly pointing at
// the real page constructor.
//
// wrapCtorForPatching(ctor) returns a stand-in for the constructor whose
// `.prototype` is a Proxy: any function assigned onto it gets run through
// exportFunction first. On Chrome (no exportFunction/cloneInto) this is a
// no-op passthrough, same as makePageWindowProxy above.
var __wrappedCtors = (typeof WeakMap !== "undefined") ? new WeakMap() : null;

function wrapCtorForPatching(realCtor) {
    if (typeof exportFunction !== "function" || typeof cloneInto !== "function") {
        return realCtor; // Chrome/Edge/etc -- direct assignment already works.
    }
    if (!realCtor || typeof realCtor !== "function") return realCtor;
    if (__wrappedCtors && __wrappedCtors.has(realCtor)) return __wrappedCtors.get(realCtor);

    var protoProxy = new Proxy(realCtor.prototype, {
        get: function (t, prop) { return Reflect.get(t, prop, t); },
        set: function (t, prop, value) {
            if (typeof value === "function") {
                try {
                    value = exportFunction(value, __realWindow, { defineAs: typeof prop === "string" ? prop : undefined });
                } catch (e) {
                    console.error("[Instafn] exportFunction failed for prototype." + String(prop), e);
                }
            }
            return Reflect.set(t, prop, value);
        }
    });

    // The Proxy target here is a throwaway plain function, NOT realCtor
    // itself -- a native constructor's own .prototype descriptor is
    // {writable:false, configurable:false}, and returning a different
    // object for it from a `get` trap on a Proxy targeting realCtor
    // directly violates the Proxy invariant for non-configurable,
    // non-writable properties (throws a TypeError the moment anything
    // reads `.prototype`). A fresh function's own .prototype is writable/
    // configurable by default, so the same substitution is legal there.
    var dummyTarget = function () {};
    var shim = new Proxy(dummyTarget, {
        get: function (t, prop) {
            if (prop === "prototype") return protoProxy;
            var v = Reflect.get(realCtor, prop, realCtor);
            return (typeof v === "function") ? v.bind(realCtor) : v;
        },
        construct: function (t, args, newTarget) {
            return Reflect.construct(realCtor, args, newTarget === shim ? realCtor : newTarget);
        },
        has: function (t, prop) { return prop in realCtor; }
    });
    if (__wrappedCtors) __wrappedCtors.set(realCtor, shim);
    return shim;
}

// ---- replacement for vendor's utils/scriptInjector.js -----------------
// Same exported shape (injectScript, injectScripts) so every vendored
// feature file that does `import { injectScript } from "./utils/
// scriptInjector.js"` keeps working unmodified -- only the underlying
// mechanism changes, from "create a <script src>" to "call the page-script
// function directly". The `path` argument upstream was a chrome-extension://
// relative path like "content/features/message-logger/socket-sniffer.js";
// we accept the same strings and map them onto PAGE_SCRIPTS keys.
(function () {
    var PATH_TO_KEY = {
        "content/features/message-logger/socket-sniffer.js": "features/message-logger/socket-sniffer.js",
        "content/features/message-logger/graphql-sniffer.js": "features/message-logger/graphql-sniffer.js",
        "content/features/story-blocking/storyblocking.js": "features/story-blocking/storyblocking.js",
        "content/features/media-downloader/voice-sniffer.js": "features/media-downloader/voice-sniffer.js",
        "content/features/typing-receipt-blocker/websocket-interceptor.js": "features/typing-receipt-blocker/websocket-interceptor.js"
    };

    defineModule("utils/scriptInjector.js", function (module, exports) {
        exports.injectScript = function (scriptPath, options) {
            options = options || {};
            var key = PATH_TO_KEY[scriptPath] || scriptPath;
            var ok = runPageScript(key);
            if (ok && options.onLoad) options.onLoad();
            if (!ok && options.onError) options.onError(new Error("page script not found: " + scriptPath));
            return ok;
        };
        exports.injectScripts = function (scriptPaths, options) {
            for (var i = 0; i < scriptPaths.length; i++) {
                exports.injectScript(scriptPaths[i], options);
            }
        };
    });
})();

// ---- replacement for vendor's utils/styleLoader.js ---------------------
// Upstream loaded each feature's .css as a <link href=chrome-extension://...>.
// We embed every stylesheet's text at build time (STYLE_SOURCES, populated
// by transform.js) and add it with GM_addStyle, which -- like GM_download
// above -- runs outside the page's CSP entirely, so style-src restrictions
// never come into play.
(function () {
    var injected = Object.create(null);

    defineModule("utils/styleLoader.js", function (module, exports) {
        exports.injectStylesheet = function (path, key) {
            key = key || path;
            if (injected[key]) return;
            // Vendored callers pass the same "content/features/..." style path
            // used for chrome.runtime.getURL upstream; our STYLE_SOURCES keys
            // (see CSS_LIST in transform.js) are relative to vendor/instafn/
            // content/ instead, i.e. without that leading segment.
            var lookupPath = path.indexOf("content/") === 0 ? path.slice("content/".length) : path;
            var css = STYLE_SOURCES[lookupPath];
            if (css === undefined) {
                console.error("[Instafn] injectStylesheet: no embedded CSS for", path);
                return;
            }
            if (typeof GM_addStyle === "function") {
                GM_addStyle(css);
            } else {
                var style = document.createElement("style");
                style.textContent = css;
                style.dataset.instafnStyle = key;
                (document.head || document.documentElement).appendChild(style);
            }
            injected[key] = true;
        };
    });
})();


var SETTINGS_ROOT_ID = "instafn-settings-root";

var SETTINGS_PAGE_HTML = "\n    <!-- Splash Screen -->\n    <div id=\"splashScreen\" class=\"splash-screen\">\n      <div class=\"splash-content\">\n        <img src=\"../icons/icon.png\" alt=\"Instafn\" class=\"splash-icon\" />\n        <h1 class=\"splash-title\">Welcome to Instafn</h1>\n        <p class=\"splash-description\">\n          Instafn is a feature-rich mod for Instagram web that allows you to\n          customize your Instagram experience.\n        </p>\n        <div class=\"splash-info\">\n          <div>\n            <h2>Enable features</h2>\n            <p>\n              Browse the categories in the settings and toggle your desired\n              features on or off. Click \"Save Changes\" to apply your settings.\n            </p>\n          </div>\n\n          <div>\n            <h2>Made by afn</h2>\n            <p>\n              I wanted to make an extension that I use daily. Please contact me\n              if there are any bugs or feature requests! Made with lots of love\n              by\n              <a\n                href=\"https://afn.im\"\n                target=\"_blank\"\n                rel=\"noopener noreferrer\"\n                class=\"about-link\"\n                >afn.im</a\n              >\n              &lt;3\n            </p>\n          </div>\n        </div>\n        <button id=\"continueButton\" class=\"splash-button\">Continue</button>\n      </div>\n    </div>\n\n    <!-- Main Settings Page -->\n    <div id=\"settingsPage\" class=\"settings-page hidden\">\n      <header>\n        <h1>Instafn</h1>\n      </header>\n      <div class=\"settings-container\">\n        <!-- Sidebar with Feature Categories -->\n        <aside class=\"sidebar\">\n          <nav class=\"sidebar-nav\">\n            <button class=\"sidebar-item active\" data-section=\"profile\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                >\n                  <path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\" />\n                  <circle cx=\"12\" cy=\"7\" r=\"4\" />\n                </svg>\n              </div>\n              <span>Profile</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"privacy\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                >\n                  <path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\" />\n                </svg>\n              </div>\n              <span>Privacy & Receipts</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"messages\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                >\n                  <path\n                    d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"\n                  />\n                </svg>\n              </div>\n              <span>Messages</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"media\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                >\n                  <rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\" />\n                  <circle cx=\"8.5\" cy=\"8.5\" r=\"1.5\" />\n                  <polyline points=\"21 15 16 10 5 21\" />\n                </svg>\n              </div>\n              <span>Video & Media</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"downloads\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                  stroke-linecap=\"round\"\n                  stroke-linejoin=\"round\"\n                >\n                  <path d=\"M12 3v12\" />\n                  <path d=\"M7 11l5 5 5-5\" />\n                  <path d=\"M4 21h16\" />\n                </svg>\n              </div>\n              <span>Downloads</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"display\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                  stroke-linecap=\"round\"\n                  stroke-linejoin=\"round\"\n                >\n                  <path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z\" />\n                  <circle cx=\"12\" cy=\"12\" r=\"3\" />\n                </svg>\n              </div>\n              <span>Display</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"backup\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                  stroke-linecap=\"round\"\n                  stroke-linejoin=\"round\"\n                >\n                  <path d=\"M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z\" />\n                  <polyline points=\"17 21 17 13 7 13 7 21\" />\n                  <polyline points=\"7 3 7 8 15 8\" />\n                </svg>\n              </div>\n              <span>Backup</span>\n            </button>\n\n            <button class=\"sidebar-item\" data-section=\"about\">\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                  stroke-linecap=\"round\"\n                  stroke-linejoin=\"round\"\n                >\n                  <circle cx=\"12\" cy=\"12\" r=\"10\" />\n                  <line x1=\"12\" y1=\"16\" x2=\"12\" y2=\"12\" />\n                  <line x1=\"12\" y1=\"8\" x2=\"12.01\" y2=\"8\" />\n                </svg>\n              </div>\n              <span>About</span>\n            </button>\n\n            <button\n              class=\"sidebar-item\"\n              id=\"developerSidebarItem\"\n              data-section=\"developer\"\n              style=\"display: none\"\n            >\n              <div class=\"sidebar-item-icon\">\n                <svg\n                  width=\"20\"\n                  height=\"20\"\n                  viewBox=\"0 0 24 24\"\n                  fill=\"none\"\n                  stroke=\"currentColor\"\n                  stroke-width=\"2\"\n                  stroke-linecap=\"round\"\n                  stroke-linejoin=\"round\"\n                >\n                  <polyline points=\"16 18 22 12 16 6\" />\n                  <polyline points=\"8 6 2 12 8 18\" />\n                </svg>\n              </div>\n              <span>Developer</span>\n            </button>\n          </nav>\n        </aside>\n\n        <!-- Main Content Area -->\n        <main class=\"settings-main\">\n          <!-- Privacy & Receipts -->\n          <div class=\"section-content\" data-section=\"privacy\">\n            <h2 class=\"section-title\">Privacy & Receipts</h2>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Block Story Seen Receipts</span>\n                  <span class=\"setting-description\"\n                    >Prevents automatically marking stories as seen when you\n                    view them.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"blockStorySeen\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n              <div class=\"setting-nested\" id=\"nestedStorySeen\">\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\"\n                        >Manual Mark as Seen Button</span\n                      >\n                      <span class=\"setting-description\"\n                        >Adds a button next the to like button in stories to\n                        manually mark the story as seen.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"enableManualMarkAsSeen\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Block Typing Receipts</span>\n                  <span class=\"setting-description\"\n                    >Blocks typing receipts from being sent to the server in\n                    messages.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"blockTypingReceipts\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n          </div>\n\n          <!-- Profile Features -->\n          <div class=\"section-content active\" data-section=\"profile\">\n            <h2 class=\"section-title\">Profile</h2>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\"\n                    >Show Follow Status Indicator</span\n                  >\n                  <span class=\"setting-description\"\n                    >Displays whether a user follows you or not on their profile\n                    page.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableProfileFollowIndicator\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Follow Analyzer</span>\n                  <span class=\"setting-description\"\n                    >The analyzer makes a lot of requests to Instagram's servers\n                    to get your followers and following. On large accounts\n                    (13,000+ connections) this MAY get you rate-limited. Use at\n                    your own risk.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"activateFollowAnalyzer\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Profile Picture Popup</span>\n                  <span class=\"setting-description\"\n                    >Long press a profile picture on a user's profile to see an\n                    enlarged view.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableProfilePicPopup\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Highlight Popup</span>\n                  <span class=\"setting-description\"\n                    >Long press a highlight on a user's profile to see an\n                    enlarged view.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableHighlightPopup\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting time-format-wrapper\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Show Date on Post Hover</span>\n                  <span class=\"setting-description\"\n                    >When hovering over a post on a profile page, show the date\n                    underneath like and comment counts.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enablePostHoverInfo\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n              <div class=\"setting-nested inline\" id=\"nestedPostHoverDateFormat\">\n                <div class=\"date-format-field\">\n                  <select\n                    class=\"date-format-select\"\n                    data-date-select=\"postHoverDateFormat\"\n                  ></select>\n                  <div class=\"date-format-preview\">\n                    Preview:\n                    <span data-date-preview=\"postHoverDateFormat\"></span>\n                  </div>\n                  <div\n                    class=\"date-format-custom\"\n                    data-date-custom=\"postHoverDateFormat\"\n                    hidden\n                  >\n                    <input\n                      type=\"text\"\n                      id=\"postHoverDateFormat\"\n                      class=\"date-format-input\"\n                      spellcheck=\"false\"\n                      autocomplete=\"off\"\n                      autocapitalize=\"off\"\n                      placeholder=\"{M}/{D}/{YY}\"\n                    />\n                    <details class=\"date-format-help\">\n                      <summary>Available tokens</summary>\n                      <div class=\"date-token-legend\" data-date-legend></div>\n                    </details>\n                  </div>\n                </div>\n              </div>\n            </div>\n            <div class=\"setting time-format-wrapper\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Profile Grid Columns</span>\n                  <span class=\"setting-description\"\n                    >Set how many columns you see on a profile's grid.</span\n                  >\n                </div>\n              </div>\n              <div class=\"date-format-field\">\n                <select id=\"profileGridColumns\" class=\"date-format-select\">\n                  <option value=\"default\" selected>Default (auto layout)</option>\n                  <option value=\"1\">1 column</option>\n                  <option value=\"2\">2 columns</option>\n                  <option value=\"3\">3 columns</option>\n                  <option value=\"4\">4 columns</option>\n                  <option value=\"5\">5 columns</option>\n                  <option value=\"6\">6 columns</option>\n                  <option value=\"7\">7 columns</option>\n                  <option value=\"8\">8 columns</option>\n                </select>\n              </div>\n            </div>\n          </div>\n\n          <!-- Video & Media -->\n          <div class=\"section-content\" data-section=\"media\">\n            <h2 class=\"section-title\">Video & Media</h2>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Universal Video Scrubber</span>\n                  <span class=\"setting-description\"\n                    >Adds a video scrubber to every video without native\n                    controls, including reels, stories, and videos in the feed.\n                    Also shows the current time and duration of the video.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableVideoScrubber\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Hold Video for 2x Speed</span>\n                  <span class=\"setting-description\"\n                    >Press and hold a video, or hold the spacebar while the\n                    video is focused / on the page, to fast-forward at 2x speed.\n                    Let go to return to normal.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableReelSpeedHold\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Drag Carousel Dots to Scrub</span>\n                  <span class=\"setting-description\"\n                    >Drag across a carousel post's dot indicator to snap-scroll\n                    through its images.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableCarouselDotDrag\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n          </div>\n\n          <!-- Messages -->\n          <div class=\"section-content\" data-section=\"messages\">\n            <h2 class=\"section-title\">Messages</h2>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Native DM Themes</span>\n                  <span class=\"setting-description\"\n                    >Uses the actual theme set in your chat as the background and\n                    colour scheme, just like on mobile.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableDMBackground\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Message Logger</span>\n                  <span class=\"setting-description\"\n                    >Logs deleted messages in the extension. View deleted\n                    messages by clicking the box button in the messages textbox.\n                    Only logs messages when the Instagram website is\n                    active.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableMessageLogger\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Double-Tap to Like Messages</span>\n                  <span class=\"setting-description\"\n                    >Double tap a message in direct messages to like it. Works\n                    with a changed default like emoji</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableMessageDoubleTapLike\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Quick Reply</span>\n                  <span class=\"setting-description\"\n                    >Adds a keyboard shortcut to reply to the last message.\n                    Ctrl/⌘ + ↑ to reply to the last message when the textbox is\n                    focused and empty. Press multiple times to navigate up in\n                    available messages.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableMessageReplyShortcut\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Quick Edit</span>\n                  <span class=\"setting-description\"\n                    >Adds a keyboard shortcut to edit your last message. Ctrl/⌘\n                    + Shift + ↑ to edit your last message when the textbox is\n                    focused and empty.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableMessageEditShortcut\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n          </div>\n\n          <!-- Downloads -->\n          <div class=\"section-content\" data-section=\"downloads\">\n            <h2 class=\"section-title\">Downloads</h2>\n            <div class=\"section-description\">\n              Adds download buttons across Instagram that save media at the best\n              available quality.\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Enable Downloads</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableMediaDownloader\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n              <div class=\"setting-nested\" id=\"nestedMediaDownloader\">\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Ask for Quality</span>\n                      <span class=\"setting-description\"\n                        >Before each download, open a dialog to pick the\n                        resolution. When off, the highest available quality is\n                        always saved.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadAskQuality\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Ask Where to Save</span>\n                      <span class=\"setting-description\"\n                        >Show the browser's \"Save As\" dialog for each download\n                        instead of saving straight to your Downloads folder.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadAskLocation\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Posts</span>\n                      <span class=\"setting-description\"\n                        >Adds a download button to the action bar of posts.\n                        Carousels have the option to save one or all media.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadOnPosts\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Reels</span>\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadOnReels\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Stories</span>\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadOnStories\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Profile Pictures</span>\n                      <span class=\"setting-description\"\n                        >Hover over a profile picture to reveal a download\n                        button.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadProfilePictures\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Voice Messages</span>\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadAudioMessages\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Chat Attachments</span>\n                      <span class=\"setting-description\"\n                        >Adds a download button next to the hover buttons in\n                        messages.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadChatImages\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Embed Metadata</span>\n                      <span class=\"setting-description\"\n                        >Saves all media with its creator, caption, date, and\n                        location in the metadata whenever available.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"downloadEmbedMetadata\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n              </div>\n            </div>\n          </div>\n\n          <!-- Display -->\n          <div class=\"section-content\" data-section=\"display\">\n            <h2 class=\"section-title\">Display</h2>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Show Elapsed Time in Calls</span>\n                  <span class=\"setting-description\"\n                    >Shows how long a call has been active while you are in a\n                    call.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"enableCallTimer\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting time-format-wrapper\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Show Exact Time on Dates</span>\n                  <span class=\"setting-description\"\n                    >Replaces every relative date on Instagram (e.g. \"2d\") with\n                    an exact date.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"showExactTime\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n              <div class=\"setting-nested inline\" id=\"nestedTimeFormat\">\n                <div class=\"date-format-field\">\n                  <select\n                    class=\"date-format-select\"\n                    data-date-select=\"timeFormat\"\n                  ></select>\n                  <div class=\"date-format-preview\">\n                    Preview: <span data-date-preview=\"timeFormat\"></span>\n                  </div>\n                  <div class=\"date-format-custom\" data-date-custom=\"timeFormat\" hidden>\n                    <input\n                      type=\"text\"\n                      id=\"timeFormat\"\n                      class=\"date-format-input\"\n                      spellcheck=\"false\"\n                      autocomplete=\"off\"\n                      autocapitalize=\"off\"\n                      placeholder=\"{M}/{D}/{YY}, {h}:{mm} {A}\"\n                    />\n                    <details class=\"date-format-help\">\n                      <summary>Available tokens</summary>\n                      <div class=\"date-token-legend\" data-date-legend></div>\n                    </details>\n                  </div>\n                </div>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Hide Recent Searches</span>\n                  <span class=\"setting-description\"\n                    >Hides the recent searches section in the search UI.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"hideRecentSearches\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\"\n                    >Hide Suggested Accounts on Profiles</span\n                  >\n                  <span class=\"setting-description\"\n                    >Hides the \"Suggested for you\" accounts carousel shown on\n                    profile pages.</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input\n                    type=\"checkbox\"\n                    id=\"hideSuggestedAccountsOnProfile\"\n                  />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Remove Right Sidebar</span>\n                  <span class=\"setting-description\"\n                    >Removes the entire right column on the home feed (account\n                    switcher, suggestions, and footer).</span\n                  >\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"hideRightSidebar\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n              <div class=\"setting-nested\" id=\"nestedRightSidebar\">\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Hide Suggested Profiles</span>\n                      <span class=\"setting-description\"\n                        >Hides the \"Suggested for you\" accounts list in the home\n                        feed sidebar.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"hideSuggestedProfiles\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n                <div class=\"setting\">\n                  <div class=\"setting-content\">\n                    <div class=\"setting-info\">\n                      <span class=\"setting-title\">Hide Home Footer</span>\n                      <span class=\"setting-description\"\n                        >Hides the footer text in the home feed sidebar.</span\n                      >\n                    </div>\n                    <label class=\"toggle\">\n                      <input type=\"checkbox\" id=\"hideHomeFooter\" />\n                      <span class=\"toggle-slider\"></span>\n                    </label>\n                  </div>\n                </div>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Hide Stories Tray</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"hideStoriesTray\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Hide Notes Tray</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"hideNotesTray\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Search Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabSearch\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Explore Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabExplore\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Reels Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabReels\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Messages Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabMessages\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Notifications Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabNotifications\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Create Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabCreate\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Disable Also from Meta Tab</span>\n                </div>\n                <label class=\"toggle\">\n                  <input type=\"checkbox\" id=\"disableTabMoreFromMeta\" />\n                  <span class=\"toggle-slider\"></span>\n                </label>\n              </div>\n            </div>\n          </div>\n\n          <!-- Backup -->\n          <div class=\"section-content\" data-section=\"backup\">\n            <h2 class=\"section-title\">Backup</h2>\n            <div class=\"section-description\">\n              Export your settings to a JSON file you can keep as a backup or\n              move to another browser, then import it to restore them.\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Export Settings</span>\n                </div>\n                <button id=\"exportSettings\" class=\"backup-button\">Export</button>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Import Settings</span>\n                </div>\n                <button id=\"importSettings\" class=\"backup-button\">Import</button>\n              </div>\n            </div>\n            <input\n              type=\"file\"\n              id=\"importFileInput\"\n              accept=\"application/json,.json\"\n              hidden\n            />\n          </div>\n\n          <!-- About -->\n          <div class=\"section-content\" data-section=\"about\">\n            <h2 class=\"section-title\">About</h2>\n            <div class=\"about-content\">\n              <div class=\"about-item\">\n                <div class=\"about-label\">Version</div>\n                <div class=\"about-value\" id=\"versionNumber\">Loading...</div>\n              </div>\n              <div class=\"about-item\">\n                <div class=\"about-label\">Support</div>\n                <div class=\"about-value\">\n                  <a href=\"https://github.com/xafn/instafn/issues\" class=\"about-link\" target=\"_blank\" rel=\"noopener noreferrer\">github.com/xafn/instafn/issues</a>\n                </div>\n              </div>\n              <div class=\"about-item\">\n                <div class=\"about-label\">Made by afn</div>\n                <div class=\"about-value\">\n                  <a\n                    href=\"https://afn.im\"\n                    target=\"_blank\"\n                    rel=\"noopener noreferrer\"\n                    class=\"about-link\"\n                    >afn.im</a\n                  >\n                  <a\n                    href=\"https://ko-fi.com/affan\"\n                    target=\"_blank\"\n                    rel=\"noopener noreferrer\"\n                    class=\"about-link\"\n                    >Donate :)</a\n                  >\n                </div>\n              </div>\n            </div>\n          </div>\n\n          <!-- Developer (hidden until unlocked) -->\n          <div class=\"section-content\" data-section=\"developer\">\n            <h2 class=\"section-title\">Developer</h2>\n            <div class=\"section-description\">\n              Internal tools for testing Instafn.\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Show Welcome Screen</span>\n                  <span class=\"setting-description\"\n                    >Re-open the first-run welcome screen.</span\n                  >\n                </div>\n                <button id=\"devShowWelcome\" class=\"backup-button\">Show</button>\n              </div>\n            </div>\n            <div class=\"setting\">\n              <div class=\"setting-content\">\n                <div class=\"setting-info\">\n                  <span class=\"setting-title\">Open Instagram with Changelog</span>\n                  <span class=\"setting-description\"\n                    >Opens Instagram's homepage with the \"What's New\" changelog\n                    showing.</span\n                  >\n                </div>\n                <button id=\"devOpenChangelog\" class=\"backup-button\">Open</button>\n              </div>\n            </div>\n          </div>\n        </main>\n      </div>\n      <footer>\n        <button id=\"save\" class=\"save-button\">Save Changes</button>\n      </footer>\n    </div>\n    \n    \n    \n    \n  ";

var SETTINGS_PAGE_CSS = "#instafn-settings-root{\n    --ig-primary-text: 38, 38, 38;\n    --ig-secondary-text: 142, 142, 142;\n    --ig-primary-icon: 38, 38, 38;\n    --ig-secondary-icon: 142, 142, 142;\n    --ig-primary-background: 255, 255, 255;\n    --ig-elevated-background: 255, 255, 255;\n    --ig-secondary-background: 250, 250, 250;\n    --ig-separator: 219, 219, 219;\n    --ig-highlight-background: 239, 239, 239;\n    --ig-colors-button-primary-background: 74, 96, 255;\n    --ig-colors-button-primary-text: 255, 255, 255;\n    --ig-colors-button-primary-background--hover: 90, 110, 255;\n    --ig-colors-button-primary-background--pressed: 60, 80, 240;\n    --ig-colors-button-secondary-background: 239, 239, 239;\n    --ig-colors-button-secondary-text: 38, 38, 38;\n    --ig-secondary-button-background: 239, 239, 239;\n    --ig-secondary-button: 38, 38, 38;\n    --ig-error-or-destructive: 237, 73, 86;\n    --toggle-off-track: 142, 142, 142;\n    --toggle-off-knob: 255, 255, 255;\n    --toggle-on-track: 0, 0, 0;\n    --toggle-on-knob: 255, 255, 255;\n    --toggle-border: 219, 219, 219;\n    --font-family-system: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n    --font-weight-system-semibold: 600;\n    --system-14-font-size: 14px;\n    --system-16-font-size: 16px;\n    --system-13-font-size: 13px;\n    --system-18-font-size: 18px;\n    \n    --igds-dialog-border-radius: 24px;\n    --ig-temporary-highlight: 0, 149, 246;\n    --ig-colors-button-primary-background--disabled: 24, 32, 139;\n    --ig-colors-button-primary-text--disabled: 255, 255, 255;\n}\n\n\n@media (prefers-color-scheme: dark) {#instafn-settings-root{\n        --ig-primary-text: 245, 245, 245;\n        --ig-secondary-text: 168, 168, 168;\n        --ig-primary-icon: 245, 245, 245;\n        --ig-secondary-icon: 168, 168, 168;\n        --ig-primary-background: 12, 16, 20;\n        --ig-elevated-background: 38, 38, 38;\n        --ig-secondary-background: 18, 18, 18;\n        --ig-separator: 54, 54, 54;\n        --ig-highlight-background: 54, 54, 54;\n        --ig-colors-button-primary-background: 74, 96, 255;\n        --ig-colors-button-primary-text: 255, 255, 255;\n        --ig-colors-button-primary-background--hover: 90, 110, 255;\n        --ig-colors-button-primary-background--pressed: 60, 80, 240;\n        --ig-colors-button-secondary-background: 54, 54, 54;\n        --ig-colors-button-secondary-text: 245, 245, 245;\n        --ig-secondary-button-background: 54, 54, 54;\n        --ig-secondary-button: 245, 245, 245;\n        --ig-error-or-destructive: 237, 73, 86;\n        --toggle-off-track: 54, 54, 54;\n        --toggle-off-knob: 142, 142, 142;\n        --toggle-on-track: 255, 255, 255;\n        --toggle-on-knob: 38, 38, 38;\n        --toggle-border: 54, 54, 54;\n    }\n}#instafn-settings-root, #instafn-settings-root *{\n    box-sizing: border-box;\n}#instafn-settings-root{\n    font-family: var(--font-family-system);\n    margin: 0;\n    padding: 0;\n    background: rgb(var(--ig-primary-background));\n    color: rgb(var(--ig-primary-text));\n    min-height: 100vh;\n    display: flex;\n    flex-direction: column;\n    position: relative;\n}#instafn-settings-root .hidden{\n    display: none !important;\n}#instafn-settings-root .splash-screen{\n    position: fixed;\n    top: 0;\n    left: 0;\n    right: 0;\n    bottom: 0;\n    background: rgb(var(--ig-primary-background));\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    z-index: 1000;\n    overflow-y: auto;\n}#instafn-settings-root .splash-content{\n    max-width: 500px;\n    width: 90%;\n    padding: 40px 32px;\n    text-align: center;\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    gap: 24px;\n}#instafn-settings-root .splash-icon{\n    width: 80px;\n    height: 80px;\n    border-radius: 16px;\n}#instafn-settings-root .splash-title{\n    font-size: 28px;\n    font-weight: var(--font-weight-system-semibold);\n    margin: 0;\n    color: rgb(var(--ig-primary-text));\n}#instafn-settings-root .splash-description{\n    font-size: var(--system-16-font-size);\n    color: rgb(var(--ig-secondary-text));\n    margin: 0 0 8px 0;\n    line-height: 1.5;\n}#instafn-settings-root .splash-info{\n    text-align: left;\n    width: 100%;\n    display: flex;\n    flex-direction: column;\n    gap: 20px;\n    margin-top: 8px;\n}#instafn-settings-root .splash-info h2{\n    font-size: 18px;\n    font-weight: var(--font-weight-system-semibold);\n    margin: 0 0 2px 0;\n    color: rgb(var(--ig-primary-text));\n}#instafn-settings-root .splash-info p{\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n    margin: 0;\n    line-height: 1.5;\n}#instafn-settings-root .splash-button{\n    background: rgb(var(--ig-colors-button-primary-background));\n    color: rgb(var(--ig-colors-button-primary-text));\n    border: none;\n    border-radius: 8px;\n    padding: 12px 32px;\n    font-size: var(--system-14-font-size);\n    font-weight: var(--font-weight-system-semibold);\n    font-family: var(--font-family-system);\n    cursor: pointer;\n    transition: all 0.2s;\n    min-width: 140px;\n    margin-top: 8px;\n}#instafn-settings-root .splash-button:hover{\n    background: rgb(var(--ig-colors-button-primary-background--hover));\n}#instafn-settings-root .splash-button:active{\n    background: rgb(var(--ig-colors-button-primary-background--pressed));\n}#instafn-settings-root .settings-page{\n    display: flex;\n    flex-direction: column;\n    height: 100vh;\n    overflow: hidden;\n}#instafn-settings-root header{\n    padding: 20px 24px;\n    border-bottom: 1px solid rgb(var(--ig-separator));\n    background: rgb(var(--ig-primary-background));\n    flex-shrink: 0;\n}#instafn-settings-root header h1{\n    font-size: 22px;\n    font-weight: var(--font-weight-system-semibold);\n    margin: 0;\n    color: rgb(var(--ig-primary-text));\n}#instafn-settings-root .settings-container{\n    display: flex;\n    flex: 1;\n    overflow: hidden;\n    min-height: 0;\n}#instafn-settings-root .sidebar{\n    width: 240px;\n    background: rgb(var(--ig-primary-background));\n    border-right: 1px solid rgb(var(--ig-separator));\n    flex-shrink: 0;\n    overflow-y: auto;\n}#instafn-settings-root .sidebar-nav{\n    display: flex;\n    flex-direction: column;\n    padding: 8px;\n}#instafn-settings-root .sidebar-item{\n    display: flex;\n    align-items: center;\n    gap: 12px;\n    padding: 12px 16px;\n    border: none;\n    background: transparent;\n    color: rgb(var(--ig-primary-text));\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n    cursor: pointer;\n    border-radius: 8px;\n    transition: background-color 0.2s;\n    text-align: left;\n    width: 100%;\n}#instafn-settings-root .sidebar-item:hover{\n    background: rgb(var(--ig-highlight-background));\n}#instafn-settings-root .sidebar-item.active{\n    background: rgb(var(--ig-highlight-background));\n    font-weight: var(--font-weight-system-semibold);\n}#instafn-settings-root .sidebar-item-icon{\n    width: 20px;\n    height: 20px;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    flex-shrink: 0;\n    color: rgb(var(--ig-primary-icon));\n}#instafn-settings-root .sidebar-item-icon svg{\n    width: 20px;\n    height: 20px;\n}#instafn-settings-root .settings-main{\n    flex: 1;\n    overflow-y: auto;\n    padding: 32px 40px;\n    background: rgb(var(--ig-primary-background));\n}#instafn-settings-root .section-content{\n    display: none;\n}#instafn-settings-root .section-content.active{\n    display: block;\n}#instafn-settings-root .section-title{\n    font-size: 24px;\n    font-weight: var(--font-weight-system-semibold);\n    margin: 0 0 24px 0;\n    color: rgb(var(--ig-primary-text));\n}#instafn-settings-root .section-description{\n    display: block;\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n    margin: 0 0 24px 0;\n    line-height: 1.5;\n}#instafn-settings-root .setting{\n    border-bottom: none;\n    padding: 0;\n    background: rgb(var(--ig-primary-background));\n    position: relative;\n    margin-bottom: 0;\n}#instafn-settings-root .setting::after{\n    content: \"\";\n    position: absolute;\n    bottom: 0;\n    left: 0;\n    right: 0;\n    height: 1px;\n    background: rgb(var(--ig-separator));\n}#instafn-settings-root .setting-content{\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    padding: 20px 0;\n    gap: 16px;\n    min-height: 48px;\n}#instafn-settings-root .setting-info{\n    flex: 1;\n    display: flex;\n    flex-direction: column;\n    gap: 4px;\n    min-width: 0;\n}#instafn-settings-root .setting-title{\n    font-size: var(--system-14-font-size);\n    font-weight: 400;\n    color: rgb(var(--ig-primary-text));\n    line-height: 1.4;\n}#instafn-settings-root .setting-description{\n    font-size: 13px;\n    color: rgb(var(--ig-secondary-text));\n    line-height: 1.4;\n}#instafn-settings-root .toggle{\n    position: relative;\n    display: inline-block;\n    width: 44px;\n    height: 24px;\n    flex-shrink: 0;\n    cursor: pointer;\n}#instafn-settings-root .toggle input{\n    opacity: 0;\n    width: 0;\n    height: 0;\n}#instafn-settings-root .toggle-slider{\n    position: absolute;\n    cursor: pointer;\n    top: 0;\n    left: 0;\n    right: 0;\n    bottom: 0;\n    background-color: rgb(var(--toggle-off-track));\n    transition: 0.2s;\n    border-radius: 12px;\n    border: 1px solid rgb(var(--toggle-border));\n}#instafn-settings-root .toggle-slider:before{\n    position: absolute;\n    content: \"\";\n    height: 18px;\n    width: 18px;\n    left: 3px;\n    top: 50%;\n    transform: translateY(-50%);\n    background-color: rgb(var(--toggle-off-knob));\n    transition: 0.2s;\n    border-radius: 50%;\n}#instafn-settings-root .toggle input:checked + .toggle-slider{\n    background-color: rgb(var(--toggle-on-track));\n    border: 1px solid rgb(var(--toggle-border));\n}#instafn-settings-root .toggle input:checked + .toggle-slider:before{\n    transform: translateX(20px) translateY(-50%);\n    background-color: rgb(var(--toggle-on-knob));\n}#instafn-settings-root .toggle input:disabled + .toggle-slider{\n    opacity: 0.5;\n    cursor: not-allowed;\n}#instafn-settings-root .setting-nested{\n    display: block;\n    border-top: 1px solid rgb(var(--ig-separator));\n}#instafn-settings-root .setting-nested.inline{\n    border-top: none;\n}#instafn-settings-root .setting-nested .setting{\n    border-bottom: none;\n}#instafn-settings-root .setting-nested .setting:last-child{\n    border-bottom: none;\n}#instafn-settings-root .setting-nested .setting-content{\n    opacity: 0.5;\n    pointer-events: none;\n}#instafn-settings-root .setting-nested.enabled .setting-content{\n    opacity: 1;\n    pointer-events: auto;\n}#instafn-settings-root .setting-nested .toggle, #instafn-settings-root .setting-nested .time-format-select{\n    cursor: not-allowed;\n    pointer-events: none;\n}#instafn-settings-root .setting-nested.enabled .toggle, #instafn-settings-root .setting-nested.enabled .time-format-select{\n    cursor: pointer;\n    pointer-events: auto;\n}#instafn-settings-root .setting-nested .toggle input{\n    cursor: not-allowed;\n    pointer-events: none;\n}#instafn-settings-root .setting-nested.enabled .toggle input{\n    cursor: pointer;\n    pointer-events: auto;\n}#instafn-settings-root .time-format-wrapper{\n    padding: 0;\n    background: rgb(var(--ig-primary-background));\n}#instafn-settings-root .time-format-wrapper .setting-content{\n    padding-bottom: 12px;\n}#instafn-settings-root .time-format-select{\n    width: 100%;\n    max-width: 400px;\n    margin: 0 0 20px 0;\n    padding: 8px 12px;\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n    border: 1px solid rgb(var(--ig-separator));\n    border-radius: 8px;\n    background: rgb(var(--ig-elevated-background));\n    color: rgb(var(--ig-primary-text));\n    cursor: pointer;\n    outline: none;\n    transition: border-color 0.2s;\n}#instafn-settings-root .time-format-select:hover{\n    border-color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .time-format-select:focus{\n    border-color: rgb(var(--ig-colors-button-primary-background));\n}#instafn-settings-root .date-format-field{\n    max-width: 440px;\n    margin: 0;\n    padding-bottom: 20px;\n}#instafn-settings-root .setting-nested:not(.enabled) .date-format-field{\n    opacity: 0.5;\n    pointer-events: none;\n}#instafn-settings-root .date-format-select{\n    width: 100%;\n    padding: 9px 40px 9px 12px;\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n    border: 1px solid rgb(var(--ig-separator));\n    border-radius: 8px;\n    background-color: rgb(var(--ig-elevated-background));\n    background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%238e8e8e' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5 6 8 9.5 4.5'/%3E%3C/svg%3E\");\n    background-repeat: no-repeat;\n    background-position: right 16px center;\n    color: rgb(var(--ig-primary-text));\n    cursor: pointer;\n    outline: none;\n    appearance: none;\n    -webkit-appearance: none;\n    transition: border-color 0.2s;\n}\n\n@media (prefers-color-scheme: dark) {#instafn-settings-root .date-format-select{\n        background-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23a8a8a8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5 6 8 9.5 4.5'/%3E%3C/svg%3E\");\n    }\n}#instafn-settings-root .date-format-select:hover{\n    border-color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .date-format-select:focus{\n    border-color: rgb(var(--ig-colors-button-primary-background));\n}#instafn-settings-root .date-format-select:disabled{\n    opacity: 0.6;\n    cursor: not-allowed;\n}#instafn-settings-root .date-format-custom{\n    margin-top: 0;\n}#instafn-settings-root .date-format-input{\n    width: 100%;\n    padding: 9px 12px;\n    font-size: var(--system-14-font-size);\n    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n    border: 1px solid rgb(var(--ig-separator));\n    border-radius: 8px;\n    background: rgb(var(--ig-elevated-background));\n    color: rgb(var(--ig-primary-text));\n    outline: none;\n    transition: border-color 0.2s;\n}#instafn-settings-root .date-format-input:hover{\n    border-color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .date-format-input:focus{\n    border-color: rgb(var(--ig-colors-button-primary-background));\n}#instafn-settings-root .date-format-input:disabled{\n    opacity: 0.6;\n    cursor: not-allowed;\n}#instafn-settings-root .date-format-preview{\n    margin: 12px 0;\n    font-size: 13px;\n    color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .date-format-preview span{\n    color: rgb(var(--ig-primary-text));\n    font-weight: var(--font-weight-system-semibold);\n}#instafn-settings-root .date-format-help{\n    margin-top: 12px;\n    font-size: 12px;\n    color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .date-format-help summary{\n    display: flex;\n    align-items: center;\n    cursor: pointer;\n    user-select: none;\n    list-style: none;\n}#instafn-settings-root .date-format-help summary::-webkit-details-marker{\n    display: none;\n}#instafn-settings-root .date-format-help summary::before{\n    content: \"\";\n    width: 6px;\n    height: 6px;\n    margin-right: 8px;\n    border-right: 1.5px solid currentColor;\n    border-bottom: 1.5px solid currentColor;\n    transform: rotate(-45deg);\n    transition: transform 0.15s ease;\n}#instafn-settings-root .date-format-help[open] summary::before{\n    transform: rotate(45deg);\n}#instafn-settings-root .date-token-legend{\n    display: grid;\n    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));\n    gap: 6px 14px;\n    margin-top: 10px;\n}#instafn-settings-root .date-token-legend span{\n    color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .date-token-legend code{\n    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n    color: rgb(var(--ig-primary-text));\n    background: rgb(var(--ig-highlight-background));\n    padding: 1px 5px;\n    border-radius: 4px;\n    margin-right: 4px;\n}#instafn-settings-root .about-content{\n    display: flex;\n    flex-direction: column;\n    gap: 0;\n}#instafn-settings-root .about-item{\n    display: flex;\n    flex-direction: column;\n    padding: 20px 0;\n    border-bottom: 1px solid rgb(var(--ig-separator));\n    gap: 8px;\n}#instafn-settings-root .about-item:last-child{\n    border-bottom: none;\n}#instafn-settings-root .about-label{\n    font-size: var(--system-14-font-size);\n    font-weight: var(--font-weight-system-semibold);\n    color: rgb(var(--ig-primary-text));\n    margin-bottom: 4px;\n}#instafn-settings-root .about-value{\n    display: flex;\n    flex-direction: column;\n    align-items: flex-start;\n    gap: 4px;\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .about-link{\n    color: rgb(var(--ig-colors-button-primary-background));\n    text-decoration: none;\n    transition: opacity 0.2s;\n}#instafn-settings-root .about-link:hover{\n    opacity: 0.8;\n    text-decoration: underline;\n}#instafn-settings-root footer{\n    padding: 16px 32px;\n    border-top: 1px solid rgb(var(--ig-separator));\n    background: rgb(var(--ig-primary-background));\n    display: flex;\n    justify-content: flex-end;\n    flex-shrink: 0;\n    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);\n}\n\n@media (prefers-color-scheme: dark) {#instafn-settings-root footer{\n        box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);\n    }\n}#instafn-settings-root .save-button{\n    background: rgb(var(--ig-separator));\n    color: rgb(var(--ig-secondary-text));\n    border: none;\n    border-radius: 8px;\n    padding: 10px 24px;\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n    cursor: not-allowed;\n    transition: all 0.2s;\n    min-width: 120px;\n    height: 40px;\n    opacity: 0.5;\n}#instafn-settings-root .save-button.active{\n    background: rgb(var(--ig-colors-button-primary-background));\n    color: rgb(var(--ig-colors-button-primary-text));\n    cursor: pointer;\n    opacity: 1;\n}#instafn-settings-root .save-button.active:hover{\n    background: rgb(var(--ig-colors-button-primary-background--hover));\n}#instafn-settings-root .save-button.active:active{\n    background: rgb(var(--ig-colors-button-primary-background--pressed));\n}#instafn-settings-root .backup-button{\n    background: rgb(var(--ig-colors-button-secondary-background));\n    color: rgb(var(--ig-colors-button-secondary-text));\n    border: none;\n    border-radius: 8px;\n    padding: 10px 24px;\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n    cursor: pointer;\n    transition: filter 0.2s;\n    min-width: 100px;\n    height: 40px;\n    flex-shrink: 0;\n}#instafn-settings-root .backup-button:hover{\n    filter: brightness(0.93);\n}#instafn-settings-root .backup-button:active{\n    filter: brightness(0.86);\n}#instafn-settings-root .backup-status{\n    margin-top: 16px;\n    padding: 12px 16px;\n    border-radius: 8px;\n    background: rgb(var(--ig-secondary-background));\n    color: rgb(var(--ig-primary-text));\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n    opacity: 0;\n    visibility: hidden;\n    transition: opacity 0.2s;\n}#instafn-settings-root .backup-status.visible{\n    opacity: 1;\n    visibility: visible;\n}#instafn-settings-root .backup-status.error{\n    background: rgba(var(--ig-error-or-destructive), 0.12);\n    color: rgb(var(--ig-error-or-destructive));\n}#instafn-settings-root .sidebar::-webkit-scrollbar, #instafn-settings-root .settings-main::-webkit-scrollbar{\n    width: 8px;\n}#instafn-settings-root .sidebar::-webkit-scrollbar-track, #instafn-settings-root .settings-main::-webkit-scrollbar-track{\n    background: rgb(var(--ig-elevated-background));\n}#instafn-settings-root .sidebar::-webkit-scrollbar-thumb, #instafn-settings-root .settings-main::-webkit-scrollbar-thumb{\n    background: rgb(var(--ig-separator));\n    border-radius: 4px;\n}#instafn-settings-root .sidebar::-webkit-scrollbar-thumb:hover, #instafn-settings-root .settings-main::-webkit-scrollbar-thumb:hover{\n    background: rgb(var(--ig-secondary-text));\n}#instafn-settings-root .sidebar, #instafn-settings-root .settings-main{\n    scrollbar-width: thin;\n    scrollbar-color: rgb(var(--ig-separator)) rgb(var(--ig-elevated-background));\n}\n\n@media (prefers-color-scheme: dark) {#instafn-settings-root .sidebar::-webkit-scrollbar-track, #instafn-settings-root .settings-main::-webkit-scrollbar-track{\n        background: rgb(var(--ig-elevated-background));\n    }#instafn-settings-root .sidebar::-webkit-scrollbar-thumb, #instafn-settings-root .settings-main::-webkit-scrollbar-thumb{\n        background: rgb(var(--ig-separator));\n    }#instafn-settings-root .sidebar::-webkit-scrollbar-thumb:hover, #instafn-settings-root .settings-main::-webkit-scrollbar-thumb:hover{\n        background: rgb(var(--ig-secondary-text));\n    }\n}\n\n";

function __runSettingsPageScripts() {

/**
 * Reusable Toast Component (settings-page copy)
 *
 * Mirror of src/content/ui/toast.js so the extension's own settings pages
 * (popup.js / settings.js, which run as plain scripts) can show the same
 * centered toast the content script uses. Also exposed on window.InstafnToast.
 */

// A bare checkmark tick (no surrounding circle), stroked with currentColor so it
// inherits the toast's text colour. Pass it as `options.icon` for a success toast.
const CHECK_ICON =
  '<svg aria-label="Done" role="img" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">' +
  '<polyline points="20 6 9 17 4 12"></polyline>' +
  "</svg>";

/**
 * Shows a toast message in the center of the screen.
 * @param {string} message - The message to display
 * @param {Object} options - Configuration options
 * @param {number} options.duration - How long to show the toast in ms (default: 2000)
 * @param {string} options.id - Unique ID for the toast (default: 'instafn-toast')
 * @param {string} options.icon - Optional leading SVG markup (e.g. CHECK_ICON)
 */
function showToast(message, options = {}) {
  const { duration = 2000, id = "instafn-toast", icon = null } = options;

  const existing = document.getElementById(id);
  if (existing) existing.remove();

  if (!document.getElementById("instafn-toast-styles")) {
    const style = document.createElement("style");
    style.id = "instafn-toast-styles";
    style.textContent = `
      @keyframes instafn-toast-fade-in {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.98); }
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      @keyframes instafn-toast-fade-out {
        from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        to { opacity: 0; transform: translate(-50%, -50%) scale(0.98); }
      }
    `;
    document.head.appendChild(style);
  }

  const toast = document.createElement("div");
  toast.id = id;
  if (icon) {
    // text + trailing icon on one centred row. The icon markup is a trusted
    // in-extension constant (never user content), so innerHTML is safe here.
    const label = document.createElement("span");
    label.textContent = message;
    const glyph = document.createElement("span");
    glyph.style.display = "inline-flex";
    glyph.innerHTML = icon;
    toast.append(label, glyph);
  } else {
    toast.textContent = message;
  }

  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    background: "rgba(0, 0, 0, 0.72)",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    zIndex: "999999",
    pointerEvents: "none",
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.35)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    animation: "instafn-toast-fade-in 0.15s ease-out",
  });

  document.body.appendChild(toast);

  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.transition = "opacity 200ms ease, transform 200ms ease";
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%, -50%) scale(0.96)";
      setTimeout(() => toast.remove(), 220);
    }
  }, duration);
}

// Expose for the plain-script settings pages.
if (typeof window !== "undefined") {
  window.InstafnToast = { showToast, CHECK_ICON };
}


/**
 * Shared settings logic for BOTH the popup (popup.js) and the full settings
 * page (settings.js). Loaded as a classic <script> before each page's own
 * script; everything is exposed on window.InstafnSettings.
 *
 * This is the single source of truth for the settings list, so the two UIs
 * can never drift apart again. It also handles the warning modals, the
 * custom date-format fields, and live cross-view sync via storage.onChanged.
 */
(function () {
  "use strict";

  // Every setting and its default. Both UIs read/write this exact set, so a
  // setting added here shows up (and stays in sync) in both places.
  const DEFAULTS = {
    blockStorySeen: false,
    enableManualMarkAsSeen: false,
    blockTypingReceipts: false,
    activateFollowAnalyzer: false,
    enableVideoScrubber: false,
    enableReelSpeedHold: true,
    enableCarouselDotDrag: false,
    enableProfilePicPopup: false,
    enableHighlightPopup: false,
    enableProfileFollowIndicator: false,
    hideRecentSearches: false,
    hideSuggestedProfiles: false,
    hideSuggestedAccountsOnProfile: false,
    hideHomeFooter: false,
    hideRightSidebar: false,
    hideStoriesTray: false,
    hideNotesTray: false,
    disableTabSearch: false,
    disableTabExplore: false,
    disableTabReels: false,
    disableTabMessages: false,
    disableTabNotifications: false,
    disableTabCreate: false,
    disableTabMoreFromMeta: false,
    enableMessageEditShortcut: false,
    enableMessageReplyShortcut: false,
    enableMessageDoubleTapLike: false,
    enableMessageLogger: false,
    enableDMBackground: false,
    showExactTime: false,
    timeFormat: "{M}/{D}/{YY}, {h}:{mm} {A}",
    enableCallTimer: false,
    enablePostHoverInfo: false,
    postHoverDateFormat: "{M}/{D}/{YY}",
    profileGridColumns: "default",
    enableMediaDownloader: false,
    downloadOnPosts: true,
    downloadOnReels: true,
    downloadOnStories: true,
    downloadProfilePictures: true,
    downloadAudioMessages: true,
    downloadChatImages: true,
    downloadAskLocation: false,
    downloadAskQuality: false,
    downloadEmbedMetadata: true,
  };

  // Toggles that pop a warning the user must confirm before they switch ON.
  // Cancelling reverts the toggle.
  const CONFIRM_ON_ENABLE = {};

  // Parent toggle -> nested container id. `offChildren` are forced OFF whenever
  // the parent is OFF (the media sub-toggles deliberately keep their values).
  const NESTED = [
    {
      // The child is disabled (greyed) while the parent is off, but its saved
      // value is left untouched — toggling the parent must not flip it.
      parent: "blockStorySeen",
      container: "nestedStorySeen",
    },
    { parent: "enableMediaDownloader", container: "nestedMediaDownloader" },
    { parent: "showExactTime", container: "nestedTimeFormat" },
    { parent: "enablePostHoverInfo", container: "nestedPostHoverDateFormat" },
    // Inverted: removing the whole right column already hides the suggestions
    // and footer, so those sub-toggles are disabled while it's ON.
    { parent: "hideRightSidebar", container: "nestedRightSidebar", invert: true },
  ];

  // Text fields (id === storage key) that get preset chips + a live preview.
  const DATE_FIELDS = ["timeFormat", "postHoverDateFormat"];

  // Dropdown sentinel for "Custom…" (reveals the token text box).
  const DATE_CUSTOM = "__custom__";

  // Each preset option in the dropdown previews the current date/time (captured
  // when the menu is built) rather than showing abstract labels.
  const DATE_PREVIEW_REF = new Date();

  const DATE_PRESETS = [
    { label: "Default", value: "{MMM} {D}, {YYYY}, {h}:{mm} {A}" },
    { label: "M/D/YY time", value: "{M}/{D}/{YY}, {h}:{mm} {A}" },
    { label: "M/D/YY", value: "{M}/{D}/{YY}" },
    { label: "US", value: "{MM}/{DD}/{YYYY}, {h}:{mm} {A}" },
    { label: "European", value: "{DD}/{MM}/{YYYY}, {HH}:{mm}" },
    { label: "ISO 8601", value: "{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}" },
    { label: "Long", value: "{MMMM} {D}, {YYYY}, {h}:{mm} {A}" },
    { label: "Day month", value: "{D} {MMM} {YYYY}" },
    { label: "Date only", value: "{MMM} {D}, {YYYY}" },
    { label: "Time only", value: "{h}:{mm} {A}" },
    { label: "DD/MM/YY", value: "{DD}/{MM}/{YY}" },
    { label: "Weekday", value: "{ddd}, {MMM} {D}, {YYYY}" },
  ];

  const TOKEN_LEGEND = [
    ["{YYYY}", "2026"],
    ["{YY}", "26"],
    ["{MMMM}", "January"],
    ["{MMM}", "Jan"],
    ["{MM}", "01"],
    ["{M}", "1"],
    ["{DD}", "07"],
    ["{D}", "7"],
    ["{dddd}", "Monday"],
    ["{ddd}", "Mon"],
    ["{HH}", "06 (24h)"],
    ["{H}", "6 (24h)"],
    ["{hh}", "06 (12h)"],
    ["{h}", "6 (12h)"],
    ["{mm}", "14"],
    ["{ss}", "52"],
    ["{A}", "AM/PM"],
    ["{a}", "am/pm"],
    ["{time}", "6:14 AM"],
    ["{date}", "Jan 7, 2026"],
  ];

  // Legacy enum format -> equivalent token string, so values saved by older
  // versions display sensibly in the new text box. The content formatter still
  // understands the old enums directly, so rendering keeps working until a
  // re-save migrates the value.
  const LEGACY_FORMAT_TO_TOKENS = {
    default: "{MMM} {D}, {YYYY}, {h}:{mm} {A}",
    full: "{MMMM} {D}, {YYYY}, {h}:{mm}:{ss} {A}",
    short: "{M}/{D}/{YYYY}, {h}:{mm} {A}",
    iso: "{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}",
    us: "{MM}/{DD}/{YYYY}, {h}:{mm} {A}",
    european: "{DD}/{MM}/{YYYY}, {HH}:{mm}",
    "date-only": "{MMM} {D}, {YYYY}",
    "time-only": "{h}:{mm} {A}",
    "24h": "{MMM} {D}, {YYYY}, {HH}:{mm}",
    "24h-full": "{MMMM} {D}, {YYYY}, {HH}:{mm}:{ss}",
    "relative-precise": "{MMM} {D}, {YYYY}, {h}:{mm} {A}",
    compact: "{D} {MMM} {YYYY}, {h}:{mm} {A}",
    rfc2822: "{ddd}, {DD} {MMM} {YYYY} {HH}:{mm}:{ss}",
    "dd/mm/yy": "{DD}/{MM}/{YY}",
    "dd/mm/yy-time": "{DD}/{MM}/{YY}, {h}:{mm} {A}",
    "mm/dd/yy": "{MM}/{DD}/{YY}",
    "mm/dd/yy-time": "{MM}/{DD}/{YY}, {h}:{mm} {A}",
    "dd/mm/yyyy": "{DD}/{MM}/{YYYY}",
    "dd/mm/yyyy-time": "{DD}/{MM}/{YYYY}, {h}:{mm} {A}",
    "mm/dd/yyyy": "{MM}/{DD}/{YYYY}",
    "day-month": "{D} {MMM} {YYYY}",
    "day-month-time": "{D} {MMM} {YYYY}, {h}:{mm} {A}",
  };

  const MONTHS_LONG = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const MONTHS_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const DAYS_LONG = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];
  const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  // Mirror of formatWithTokens() in the content script's exact-time-display.
  function formatTokens(date, fmt) {
    const Y = date.getFullYear();
    const Mi = date.getMonth();
    const D = date.getDate();
    const dow = date.getDay();
    const H = date.getHours();
    const m = date.getMinutes();
    const s = date.getSeconds();
    const h12 = H % 12 || 12;
    const ampm = H >= 12 ? "PM" : "AM";
    const map = {
      YYYY: Y,
      YY: pad(Y % 100),
      MMMM: MONTHS_LONG[Mi],
      MMM: MONTHS_SHORT[Mi],
      MM: pad(Mi + 1),
      M: Mi + 1,
      DD: pad(D),
      D: D,
      dddd: DAYS_LONG[dow],
      ddd: DAYS_SHORT[dow],
      HH: pad(H),
      H: H,
      hh: pad(h12),
      h: h12,
      mm: pad(m),
      m: m,
      ss: pad(s),
      s: s,
      A: ampm,
      a: ampm.toLowerCase(),
      time: `${h12}:${pad(m)} ${ampm}`,
      date: `${MONTHS_SHORT[Mi]} ${D}, ${Y}`,
    };
    return String(fmt).replace(/\{(\w+)\}/g, (full, t) =>
      t in map ? String(map[t]) : full
    );
  }

  // Normalize a stored format value into a token string for the text box.
  function toTokenFormat(stored) {
    if (typeof stored !== "string" || !stored) return DEFAULTS.timeFormat;
    if (stored.includes("{")) return stored; // already a token format
    if (stored in LEGACY_FORMAT_TO_TOKENS) return LEGACY_FORMAT_TO_TOKENS[stored];
    return stored; // unknown plain string: leave as-is
  }

  function formatPreview(fmt) {
    try {
      return formatTokens(new Date(), fmt);
    } catch (e) {
      return "";
    }
  }

  function readControl(el) {
    if (!el) return undefined;
    if (el.type === "checkbox") return !!el.checked;
    return el.value;
  }

  function writeControl(el, v) {
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
  }

  // ---- Confirmation modal --------------------------------------------------
  // Reuse the project's own modal component (settings/modal.js, exposed on
  // window.InstafnModal). Falls back to a native confirm() if it isn't loaded.

  function confirmDialog(opts) {
    const o = opts || {};
    if (window.InstafnModal && window.InstafnModal.confirmModal) {
      return window.InstafnModal.confirmModal({
        title: o.title || "Confirm",
        message: o.message || "Are you sure?",
        confirmText: o.confirmText || "Confirm",
        cancelText: o.cancelText || "Cancel",
      });
    }
    return Promise.resolve(window.confirm(o.message || "Are you sure?"));
  }

  // ---- Toasts --------------------------------------------------------------
  // Reuse the project's own toast (settings/toast.js, on window.InstafnToast).

  function toastSuccess(message) {
    const T = window.InstafnToast;
    if (T && T.showToast) T.showToast(message, { icon: T.CHECK_ICON });
  }

  function toastError(message) {
    const T = window.InstafnToast;
    if (T && T.showToast) T.showToast(message, { duration: 3500 });
  }

  // ---- Import / export -----------------------------------------------------

  function exportToFile(done) {
    chrome.storage.sync.get(DEFAULTS, (cfg) => {
      const settings = {};
      for (const k of Object.keys(DEFAULTS)) settings[k] = cfg[k];

      let version = "unknown";
      try {
        version = chrome.runtime.getManifest().version || version;
      } catch (e) {}

      const payload = {
        app: "instafn",
        version,
        exportedAt: new Date().toISOString(),
        settings,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `instafn-settings-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (typeof done === "function") done();
    });
  }

  // Turn a parsed JSON payload into a sanitized config patch. Returns
  // { newCfg, applied } or throws an Error with a user-facing message.
  function parseImport(parsed) {
    const incoming =
      parsed &&
      typeof parsed === "object" &&
      parsed.settings &&
      typeof parsed.settings === "object"
        ? parsed.settings
        : parsed;

    if (!incoming || typeof incoming !== "object") {
      throw new Error("unrecognized file format.");
    }

    const newCfg = {};
    let applied = 0;
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in incoming)) continue;
      const def = DEFAULTS[k];
      const val = incoming[k];
      if (typeof def === "boolean") {
        newCfg[k] = !!val;
        applied++;
      } else if (typeof def === "string" && typeof val === "string") {
        newCfg[k] = val;
        applied++;
      }
    }
    if (applied === 0) throw new Error("no recognized settings found.");
    if (!newCfg.blockStorySeen) newCfg.enableManualMarkAsSeen = false;
    return { newCfg, applied };
  }

  // ---- Form controller -----------------------------------------------------

  // Wires up an entire settings form (load/save/dirty-tracking, nested
  // toggles, date fields, confirm-on-enable modals, and live cross-view
  // sync). Both UIs share this; they only differ in navigation chrome and
  // what happens after a save (onAfterSave).
  function createForm(options) {
    const opts = options || {};
    const doc = document;
    const saveButton = doc.getElementById("save");
    let originalSettings = {};

    function checkForChanges() {
      if (!saveButton) return;
      let dirty = false;
      for (const k of Object.keys(DEFAULTS)) {
        const el = doc.getElementById(k);
        if (!el) continue;
        if (readControl(el) !== originalSettings[k]) {
          dirty = true;
          break;
        }
      }
      saveButton.classList.toggle("active", dirty);
    }

    function applyNested() {
      for (const n of NESTED) {
        const parent = doc.getElementById(n.parent);
        const container = doc.getElementById(n.container);
        if (!parent || !container) continue;
        const on = n.invert ? !parent.checked : parent.checked;
        container.classList.toggle("enabled", on);
        container
          .querySelectorAll("input, select, button")
          .forEach((c) => {
            c.disabled = !on;
          });
        if (!on && n.offChildren) {
          for (const childId of n.offChildren) {
            const child = doc.getElementById(childId);
            if (child) child.checked = false;
          }
        }
      }
    }

    function refreshDateFields() {
      for (const id of DATE_FIELDS) {
        const el = doc.getElementById(id);
        if (el && el._ifnSync) el._ifnSync();
      }
    }

    function wireNested() {
      for (const n of NESTED) {
        const parent = doc.getElementById(n.parent);
        if (parent && !parent.dataset.ifnNestedWired) {
          parent.dataset.ifnNestedWired = "1";
          parent.addEventListener("change", () => {
            applyNested();
            checkForChanges();
          });
        }
      }
    }

    function wireDateFields() {
      // Populate the token legend (shared across fields) once.
      doc.querySelectorAll("[data-date-legend]").forEach((legend) => {
        if (legend.dataset.ifnFilled) return;
        legend.dataset.ifnFilled = "1";
        legend.innerHTML = TOKEN_LEGEND.map(
          ([tok, ex]) =>
            `<span><code>${tok}</code> ${ex}</span>`
        ).join("");
      });

      for (const id of DATE_FIELDS) {
        // input#<id> is the storage-backed source of truth (a format string).
        const input = doc.getElementById(id);
        if (!input) continue;
        const select = doc.querySelector(`[data-date-select="${id}"]`);
        const preview = doc.querySelector(`[data-date-preview="${id}"]`);
        const previewRow = preview
          ? preview.closest(".date-format-preview")
          : null;
        const custom = doc.querySelector(`[data-date-custom="${id}"]`);

        const updatePreview = () => {
          if (preview)
            preview.textContent = formatPreview(input.value || DEFAULTS[id]);
        };

        // The custom token box + live preview only matter in "Custom…" mode;
        // presets already show their result right in the dropdown.
        const isCustom = () => select && select.value === DATE_CUSTOM;
        const applyVisibility = () => {
          if (custom) custom.hidden = !isCustom();
          if (previewRow) previewRow.hidden = !isCustom();
        };

        // Point the dropdown + custom box at whatever input.value currently is.
        const sync = () => {
          if (select) {
            const match = DATE_PRESETS.find((p) => p.value === input.value);
            select.value = match ? match.value : DATE_CUSTOM;
          }
          applyVisibility();
          updatePreview();
        };
        input._ifnSync = sync;
        input._ifnUpdatePreview = updatePreview;

        // Populate the dropdown once: first preset, then "Custom", then the rest.
        if (select && !select.dataset.ifnWired) {
          select.dataset.ifnWired = "1";
          const opts = [
            ...DATE_PRESETS,
            { label: "Custom…", value: DATE_CUSTOM },
          ];
          select.innerHTML = opts
            .map((o) => {
              const text =
                o.value === DATE_CUSTOM
                  ? o.label
                  : formatTokens(DATE_PREVIEW_REF, o.value);
              return `<option value="${o.value}">${text}</option>`;
            })
            .join("");
          select.addEventListener("change", () => {
            if (select.value === DATE_CUSTOM) {
              input.focus();
            } else {
              input.value = select.value;
            }
            applyVisibility();
            updatePreview();
            checkForChanges();
          });
        }

        if (!input.dataset.ifnWired) {
          input.dataset.ifnWired = "1";
          input.addEventListener("input", () => {
            updatePreview();
            checkForChanges();
          });
        }
      }
    }

    function wireConfirmToggles() {
      for (const key of Object.keys(CONFIRM_ON_ENABLE)) {
        const el = doc.getElementById(key);
        if (!el || el.dataset.ifnConfirmWired) continue;
        el.dataset.ifnConfirmWired = "1";
        el.addEventListener("change", async () => {
          if (!el.checked) return; // only confirm when switching ON
          const cfg = CONFIRM_ON_ENABLE[key];
          const ok = await confirmDialog(cfg);
          if (!ok) el.checked = false;
          applyNested();
          checkForChanges();
        });
      }
    }

    function applyConfig(cfg, opts2) {
      const setBaseline = !(opts2 && opts2.markDirty);
      for (const k of Object.keys(DEFAULTS)) {
        const el = doc.getElementById(k);
        if (!el) continue;
        let v = cfg[k] !== undefined && cfg[k] !== null ? cfg[k] : DEFAULTS[k];
        if (DATE_FIELDS.indexOf(k) !== -1) v = toTokenFormat(v);
        writeControl(el, v);
        if (setBaseline) originalSettings[k] = readControl(el);
      }
      applyNested();
      refreshDateFields();
      checkForChanges();
    }

    function load() {
      wireNested();
      wireDateFields();
      wireConfirmToggles();
      return new Promise((resolve) => {
        chrome.storage.sync.get(DEFAULTS, (cfg) => {
          applyConfig(cfg);
          resolve(cfg);
        });
      });
    }

    function save() {
      if (!saveButton || !saveButton.classList.contains("active")) return;
      const newCfg = {};
      for (const k of Object.keys(DEFAULTS)) {
        const el = doc.getElementById(k);
        if (!el) continue;
        newCfg[k] = readControl(el);
      }
      // Mirror nested offChildren rules on save.
      for (const n of NESTED) {
        if (!n.offChildren) continue;
        const p = doc.getElementById(n.parent);
        if (p && !p.checked) {
          for (const c of n.offChildren) newCfg[c] = false;
        }
      }
      chrome.storage.sync.set(newCfg, () => {
        originalSettings = Object.assign({}, originalSettings, newCfg);
        saveButton.classList.remove("active");
        if (typeof opts.onAfterSave === "function") opts.onAfterSave(newCfg);
      });
    }

    function isDirty() {
      return !!(saveButton && saveButton.classList.contains("active"));
    }

    // Re-pull from storage and refresh the form (used after an import).
    function reloadFromStorage() {
      chrome.storage.sync.get(DEFAULTS, (cfg) => applyConfig(cfg));
    }

    // Live sync: when another open view saves, reflect it here — unless the
    // user has unsaved edits in this view (don't clobber their work).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || isDirty()) return;
      let touched = false;
      for (const k of Object.keys(changes)) {
        if (!(k in DEFAULTS)) continue;
        const el = doc.getElementById(k);
        if (!el) continue;
        let v = changes[k].newValue;
        if (v === undefined) v = DEFAULTS[k];
        if (DATE_FIELDS.indexOf(k) !== -1) v = toTokenFormat(v);
        writeControl(el, v);
        originalSettings[k] = readControl(el);
        touched = true;
      }
      if (touched) {
        applyNested();
        refreshDateFields();
        checkForChanges();
      }
    });

    // Catch every other control change (checkboxes, selects).
    doc.addEventListener("change", checkForChanges);

    return {
      load,
      save,
      isDirty,
      reloadFromStorage,
      checkForChanges,
    };
  }

  window.InstafnSettings = {
    DEFAULTS,
    CONFIRM_ON_ENABLE,
    DATE_PRESETS,
    confirmDialog,
    toastSuccess,
    toastError,
    formatPreview,
    toTokenFormat,
    exportToFile,
    parseImport,
    createForm,
  };
})();


// Full settings page. The settings list, dirty-tracking, nested toggles,
// custom date fields, warning modals and live sync all live in the shared
// module (settings-shared.js, exposed as window.InstafnSettings); this file
// only wires up page-specific chrome: the splash screen, sidebar navigation,
// save behavior, and import/export UI.

document.addEventListener("DOMContentLoaded", () => {
  const S = window.InstafnSettings;
  const sidebarItems = document.querySelectorAll(".sidebar-item");
  const sectionContents = document.querySelectorAll(".section-content");
  const saveButton = document.getElementById("save");
  const splashScreen = document.getElementById("splashScreen");
  const settingsPage = document.getElementById("settingsPage");
  const continueButton = document.getElementById("continueButton");

  // Show splash screen on first visit
  chrome.storage.sync.get(["splashScreenShown"], (result) => {
    if (!result.splashScreenShown) {
      splashScreen.classList.remove("hidden");
      settingsPage.classList.add("hidden");
    } else {
      splashScreen.classList.add("hidden");
      settingsPage.classList.remove("hidden");
    }
  });

  if (continueButton) {
    continueButton.addEventListener("click", () => {
      splashScreen.classList.add("hidden");
      settingsPage.classList.remove("hidden");
      chrome.storage.sync.set({ splashScreenShown: true });
    });
  }

  // Load version number
  const versionElement = document.getElementById("versionNumber");
  if (versionElement) {
    try {
      versionElement.textContent =
        chrome.runtime.getManifest().version || "Unknown";
    } catch (e) {
      versionElement.textContent = "Unknown";
    }
  }

  // Sidebar navigation
  sidebarItems.forEach((item) => {
    item.addEventListener("click", () => {
      const section = item.getAttribute("data-section");
      sidebarItems.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");
      sectionContents.forEach((content) => {
        content.classList.toggle(
          "active",
          content.getAttribute("data-section") === section
        );
      });
    });
  });

  // Default active section (first sidebar item)
  const firstSidebarItem = sidebarItems[0];
  if (firstSidebarItem) {
    const firstSection = firstSidebarItem.getAttribute("data-section");
    sectionContents.forEach((content) => {
      if (content.getAttribute("data-section") === firstSection) {
        content.classList.add("active");
      }
    });
  }

  // Reload the active Instagram tab (or the first one found) so changes apply.
  function reloadInstagramTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url && tabs[0].url.includes("instagram.com")) {
        chrome.tabs.reload(tabs[0].id);
      } else {
        chrome.tabs.query({ currentWindow: true }, (allTabs) => {
          const instagramTab = allTabs.find(
            (tab) => tab.url && tab.url.includes("instagram.com")
          );
          if (instagramTab) chrome.tabs.reload(instagramTab.id);
        });
      }
    });
  }

  // Build the shared form controller. Saving here keeps the page open and just
  // reloads any open Instagram tab.
  const form = S.createForm({ onAfterSave: reloadInstagramTab });
  form.load();

  // Warn before leaving with unsaved changes. Browsers only allow their own
  // native prompt here, so the save button's "active" state is our dirty flag.
  window.addEventListener("beforeunload", (e) => {
    if (form.isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  if (saveButton) {
    saveButton.addEventListener("click", () => form.save());
  }

  // ---- Import / Export ----
  const exportBtn = document.getElementById("exportSettings");
  const importBtn = document.getElementById("importSettings");
  const importFileInput = document.getElementById("importFileInput");

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      S.exportToFile(() => S.toastSuccess("Settings exported."));
    });
  }

  if (importBtn && importFileInput) {
    importBtn.addEventListener("click", () => importFileInput.click());

    importFileInput.addEventListener("change", () => {
      const file = importFileInput.files && importFileInput.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        let result;
        try {
          result = S.parseImport(JSON.parse(reader.result));
        } catch (e) {
          const msg =
            e instanceof SyntaxError
              ? "file is not valid JSON."
              : e.message || "could not import.";
          S.toastError(`Import failed: ${msg}`);
          importFileInput.value = "";
          return;
        }

        chrome.storage.sync.set(result.newCfg, () => {
          form.reloadFromStorage();
          S.toastSuccess(
            `Imported ${result.applied} setting${
              result.applied === 1 ? "" : "s"
            }.`
          );
          reloadInstagramTab();
        });
        importFileInput.value = "";
      };
      reader.onerror = () => {
        S.toastError("Import failed: could not read file.");
        importFileInput.value = "";
      };
      reader.readAsText(file);
    });
  }

  // ---- Developer mode (Android-style easter egg) ----
  // Tap the "About" sidebar item 7 times to unlock a hidden Developer tab.
  const developerItem = document.getElementById("developerSidebarItem");
  const aboutItem = document.querySelector(
    '.sidebar-item[data-section="about"]'
  );

  function revealDeveloperTab() {
    if (developerItem) developerItem.style.display = "";
  }

  // Reuse the shared Instafn toast component.
  function devToast(message) {
    window.InstafnToast.showToast(message, {
      id: "instafn-dev-toast",
      duration: 1600,
    });
  }

  let developerMode = false;
  let aboutTaps = 0;
  const REQUIRED_TAPS = 7;

  // For users who are already developers: only nag after a few clicks in quick
  // succession, then on every quick click after that.
  let devTapStreak = 0;
  let lastDevTapTime = 0;
  const QUICK_MS = 700;
  const NAG_AFTER = 3;

  chrome.storage.sync.get({ developerMode: false }, (res) => {
    developerMode = !!res.developerMode;
    if (developerMode) revealDeveloperTab();
  });

  if (aboutItem) {
    aboutItem.addEventListener("click", () => {
      if (developerMode) {
        const now = Date.now();
        devTapStreak = now - lastDevTapTime <= QUICK_MS ? devTapStreak + 1 : 1;
        lastDevTapTime = now;
        if (devTapStreak >= NAG_AFTER) {
          devToast("No need, you are already a developer.");
        }
        return;
      }
      aboutTaps++;
      const remaining = REQUIRED_TAPS - aboutTaps;
      if (remaining <= 0) {
        developerMode = true;
        aboutTaps = 0;
        chrome.storage.sync.set({ developerMode: true });
        revealDeveloperTab();
        devToast("You are now a developer!");
      } else if (remaining <= 3) {
        devToast(
          `You are now ${remaining} step${
            remaining === 1 ? "" : "s"
          } away from being a developer.`
        );
      }
    });
  }

  // ---- Developer tools ----
  const devShowWelcome = document.getElementById("devShowWelcome");
  if (devShowWelcome) {
    devShowWelcome.addEventListener("click", () => {
      chrome.storage.sync.set({ splashScreenShown: false }, () => {
        settingsPage.classList.add("hidden");
        splashScreen.classList.remove("hidden");
        window.scrollTo(0, 0);
      });
    });
  }

  const devOpenChangelog = document.getElementById("devOpenChangelog");
  if (devOpenChangelog) {
    devOpenChangelog.addEventListener("click", () => {
      // Reset the changelog "seen" baseline to a version older than any release
      // so the content script's initChangelog() renders the "What's New" modal,
      // then open Instagram's homepage where it runs.
      chrome.storage.sync.set({ lastSeenChangelogVersion: "0" }, () => {
        chrome.tabs.create({ url: "https://www.instagram.com/" });
      });
    });
  }
});


}

// ---------------------------------------------------------------------
// Settings page (overlay-mounted)
//
// SETTINGS_ROOT_ID / SETTINGS_PAGE_HTML / SETTINGS_PAGE_CSS / 
// __runSettingsPageScripts are generated by buildSettingsPageAssets() in
// transform.js, straight from the vendored settings.html/css/js/
// settings-shared.js/toast.js -- this file only wires up *how* that gets
// mounted into an Instagram tab instead of its own document.
//
// Two things the original settings.html assumed but doesn't get here:
//   1. `document.addEventListener("DOMContentLoaded", ...)` in settings.js
//      never fires again on a page that already finished loading, so a
//      synthetic DOMContentLoaded is dispatched right after mounting.
//   2. chrome.tabs.query/reload/create (used to reload the Instagram tab
//      after saving) -- see the `tabs` shim in chrome-shim.js. Since the
//      settings UI now lives *inside* the Instagram tab instead of a
//      separate one, "reload the active Instagram tab" is just "reload
//      this page", which that shim does directly.
// ---------------------------------------------------------------------

var __settingsPageMounted = false;
var __settingsEscListenerInstalled = false;

function closeSettingsPage() {
    var existing = document.getElementById(SETTINGS_ROOT_ID);
    if (existing) existing.style.display = "none";
}

function openSettingsPage() {
    var existing = document.getElementById(SETTINGS_ROOT_ID);
    if (existing) {
        existing.style.display = "block";
        return;
    }

    if (typeof GM_addStyle === "function") {
        // SETTINGS_PAGE_CSS (scoped from the vendored settings.css) sets its
        // own `position: relative` on #SETTINGS_ROOT_ID -- that's the rule
        // that used to come from the standalone extension page's <body>.
        // Since it has the same specificity as the overlay rule below, CSS
        // source order decides the winner: putting SETTINGS_PAGE_CSS *first*
        // and the overlay rule *after* it means our fixed/inset positioning
        // wins, instead of silently losing to `position: relative` and
        // leaving the settings page laid out inline in Instagram's own
        // document flow (which is what was causing the page-scroll mess
        // instead of a proper overlay).
        GM_addStyle(
            SETTINGS_PAGE_CSS + "\n" +
            "#" + SETTINGS_ROOT_ID + " { position: fixed !important; inset: 0 !important; z-index: 2147483647; overflow: auto; }\n" +
            // The vendored header (<header><h1>Instafn</h1></header>) has no
            // close affordance -- it never needed one as a standalone
            // extension page (you'd just close the tab). #instafn-settings-close
            // is appended into that header below; this styles+positions it.
            "#instafn-settings-close { position: absolute; top: 16px; right: 20px; width: 32px; height: 32px; border-radius: 50%; border: none; background: transparent; color: rgb(var(--ig-primary-text)); font-size: 20px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }\n" +
            "#instafn-settings-close:hover { background: rgb(var(--ig-highlight-background)); }\n" +
            "#" + SETTINGS_ROOT_ID + " header { position: relative; }"
        );
    }

    var root = document.createElement("div");
    root.id = SETTINGS_ROOT_ID;
    root.innerHTML = SETTINGS_PAGE_HTML;
    (document.body || document.documentElement).appendChild(root);

    // Cross/close button -- the vendored header has none (a standalone
    // extension page just gets closed as a tab; there's no "tab" here).
    // Appended into <header>, which the CSS above makes a positioned
    // ancestor so this lands top-right of it instead of the whole overlay.
    var header = root.querySelector("header");
    if (header && !header.querySelector("#instafn-settings-close")) {
        var closeBtn = document.createElement("button");
        closeBtn.id = "instafn-settings-close";
        closeBtn.title = "Close settings";
        closeBtn.setAttribute("aria-label", "Close settings");
        closeBtn.textContent = "\u2715";
        closeBtn.onclick = closeSettingsPage;
        header.appendChild(closeBtn);
    }

    if (!__settingsEscListenerInstalled) {
        __settingsEscListenerInstalled = true;
        document.addEventListener("keydown", function (e) {
            if (e.key !== "Escape") return;
            var el = document.getElementById(SETTINGS_ROOT_ID);
            if (el && el.style.display !== "none") closeSettingsPage();
        });
    }

    if (!__settingsPageMounted) {
        // toast.js / settings-shared.js / settings.js all run once, here --
        // settings.js's own init is gated behind a DOMContentLoaded listener
        // it registers during this same call, which the dispatch right after
        // then fires.
        __runSettingsPageScripts();
        document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true, cancelable: true }));
        __settingsPageMounted = true;
    }
}

function initSettingsPageEntryPoints() {
    // The only entry point now is the userscript-manager's menu command
    // (Tampermonkey/Violentmonkey extension icon -> "Instafn settings").
    // The on-page floating settings button was removed since that's
    // redundant with the extension's own menu.
    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Instafn settings", openSettingsPage);
    }
}


// ---- embedded stylesheets ----

STYLE_SOURCES["features/profile-grid-columns/profile-grid-columns.css"] = "/* Profile Grid Columns\n *\n * Instagram renders every profile grid (Posts, Reels, Reposts, Tagged) as a\n * column of flex \"rows\", each row (`._ac7v`) holding exactly three cells baked\n * into the DOM. There is no single grid container whose column count we can just\n * override, so instead we dissolve each row with `display: contents` — its three\n * cells then become direct children of the row's parent — and turn that parent\n * into a real CSS grid with the chosen number of columns. New rows added during\n * infinite scroll are picked up automatically via `:has()`, so no observer is\n * needed.\n *\n * Everything here is gated on `html[data-instafn-grid-cols]`, which the feature\n * only sets when the user picks a non-default count while on a profile page. At\n * the default of 3 the attribute is absent and Instagram's native layout is left\n * entirely untouched.\n */\n\n/* The parent that holds the `._ac7v` rows becomes the grid. */\nhtml[data-instafn-grid-cols] div:has(> ._ac7v) {\n  display: grid !important;\n  grid-template-columns: repeat(var(--instafn-grid-cols, 3), minmax(0, 1fr)) !important;\n  gap: var(--instafn-grid-gap, 4px) !important;\n}\n\n/* Each row dissolves so its cells flow into the grid above. */\nhtml[data-instafn-grid-cols] ._ac7v {\n  display: contents !important;\n}\n\n/* Cells were sized for a 3-up flex row; let them stretch to fill their grid\n * column and drop any row-level spacing so the grid `gap` is the only gutter. */\nhtml[data-instafn-grid-cols] ._ac7v > * {\n  width: auto !important;\n  min-width: 0 !important;\n  max-width: none !important;\n  margin: 0 !important;\n}\n";


STYLE_SOURCES["features/video-scrubber/videoScrubber.css"] = ".instafn-reel-container {\n  position: relative !important;\n  isolation: isolate !important;\n}\n\n.instafn-reel-scrubber {\n  position: absolute !important;\n  bottom: -4px !important;\n  left: 0 !important;\n  right: 0 !important;\n  padding: 4px 0 4px 0 !important;\n  z-index: 2147483647 !important;\n  pointer-events: none !important;\n  opacity: 0 !important;\n  transition: opacity 0.3s ease !important;\n  isolation: isolate !important;\n}\n\n.instafn-reel-container:hover .instafn-reel-scrubber,\n.instafn-reel-container:active .instafn-reel-scrubber {\n  opacity: 1 !important;\n}\n\n.instafn-reel-scrubber-track {\n  width: 100% !important;\n  height: 6px !important;\n  background: rgba(0, 0, 0, 0.5) !important;\n  position: relative !important;\n  cursor: pointer !important;\n  pointer-events: auto !important;\n  overflow: hidden !important;\n  box-shadow: 0 -8px 16px rgba(0, 0, 0, 0.5) !important;\n  z-index: 1 !important;\n}\n\n.instafn-reel-scrubber-progress {\n  position: absolute !important;\n  top: 0 !important;\n  left: 0 !important;\n  height: 100% !important;\n  background: #ffffff !important;\n  border-top-right-radius: 3px !important;\n  border-bottom-right-radius: 3px !important;\n  width: 0%;\n  transition: width 0.1s linear;\n  z-index: 2 !important;\n  min-width: 0 !important;\n  will-change: width !important;\n  display: block !important;\n}\n\n.instafn-reel-scrubber-handle {\n  position: absolute !important;\n  top: 50% !important;\n  left: 0%;\n  width: 0px !important;\n  height: 0px !important;\n  background: transparent !important;\n  border-radius: 0 !important;\n  transform: translate(-50%, -50%) !important;\n  opacity: 0 !important;\n  transition: opacity 0.2s !important;\n  pointer-events: none !important;\n  box-shadow: none !important;\n}\n\n.instafn-reel-scrubber-handle.scrubbing {\n  transition:\n    opacity 0.2s,\n    left 0s !important;\n}\n\n.instafn-reel-container:hover .instafn-reel-scrubber-handle,\n.instafn-reel-container:active .instafn-reel-scrubber-handle {\n  opacity: 0 !important;\n}\n\n.instafn-reel-time-pill {\n  position: absolute !important;\n  bottom: 28px !important;\n  left: 50% !important;\n  transform: translateX(-50%) !important;\n  background: rgba(0, 0, 0, 0.85) !important;\n  color: white !important;\n  padding: 6px 10px !important;\n  border-radius: 16px !important;\n  font-size: 13px !important;\n  font-weight: 600 !important;\n  white-space: nowrap !important;\n  opacity: 0 !important;\n  pointer-events: none !important;\n  transition: opacity 0.15s ease !important;\n  z-index: 2147483647 !important;\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif !important;\n}\n\n.instafn-reel-time-pill.visible {\n  opacity: 1 !important;\n}\n";


STYLE_SOURCES["features/follow-analyzer/follow-analyzer.css"] = ".instafn-scan-btn {\n    background-color: rgb(var(--ig-colors-button-secondary-background)) !important;\n    color: rgb(var(--ig-colors-button-secondary-text)) !important;\n    border: none !important;\n    padding: 0 20px !important;\n    margin: 0 !important;\n    font-size: 0.875rem !important;\n    font-weight: var(--font-weight-system-semibold) !important;\n    cursor: pointer !important;\n    font-family: var(--font-family-system) !important;\n    text-decoration: none !important;\n    display: flex !important;\n    align-items: center !important;\n    justify-content: center !important;\n    gap: 6px !important;\n    line-height: var(--system-14-line-height) !important;\n    height: 44px !important;\n    border-radius: 12px !important;\n    white-space: nowrap !important;\n    flex-shrink: 0 !important;\n    position: relative !important;\n    z-index: 0 !important;\n    user-select: none !important;\n    box-sizing: border-box !important;\n    touch-action: manipulation !important;\n    appearance: none !important;\n    text-overflow: ellipsis !important;\n    min-height: 0 !important;\n    min-width: 0 !important;\n    outline: none !important;\n    -webkit-tap-highlight-color: transparent !important;\n    transition: background-color 0.2s ease !important;\n    text-align: center !important;\n    list-style-type: none !important;\n    border-start-start-radius: 12px !important;\n    border-end-start-radius: 12px !important;\n    border-start-end-radius: 12px !important;\n    border-end-end-radius: 12px !important;\n}\n\n.instafn-scan-btn:hover {\n    background-color: rgb(var(--ig-colors-button-secondary-background--hover)) !important;\n}\n\n.instafn-button-container {\n    display: flex !important;\n    gap: 12px !important;\n    justify-content: center !important;\n    align-items: center !important;\n    flex-wrap: wrap !important;\n    margin-top: 0 !important;\n    min-height: 44px !important;\n    contain: layout !important;\n    position: relative !important;\n    will-change: auto !important;\n}\n\n/* Only apply equal flex to html-div wrappers (profile page buttons), not modal buttons */\n.instafn-button-container > .html-div {\n    flex: 1 !important;\n    display: flex !important;\n    min-width: 0 !important;\n}\n\n.instafn-button-container .html-div > .instafn-scan-btn {\n    width: 100% !important;\n    display: flex !important;\n    align-items: center !important;\n    justify-content: center !important;\n}\n\n.instafn-deactivated-tag {\n    margin-left: 6px !important;\n    font-size: 12px !important;\n    color: #e47500 !important;\n    cursor: default !important;\n    vertical-align: middle !important;\n}\n\n.instafn-modal-overlay {\n    position: fixed;\n    inset: 0;\n    background: rgba(0, 0, 0, 0.65);\n    z-index: 99999;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n}\n\n.instafn-modal {\n    width: min(600px, 90vw);\n    max-height: 85vh;\n    background: rgb(var(--ig-elevated-background));\n    border-radius: var(--igds-dialog-border-radius);\n    display: flex;\n    flex-direction: column;\n    overflow: hidden;\n    border: 1px solid rgb(var(--ig-separator));\n    animation: instafn-modal-zoom-in 0.1s cubic-bezier(0.08, 0.52, 0.52, 1);\n}\n\n@keyframes instafn-modal-zoom-in {\n    0% {\n        opacity: 0;\n        transform: scale(1.2);\n    }\n    100% {\n        opacity: 1;\n        transform: scale(1);\n    }\n}\n\n.instafn-modal.instafn-modal--narrow {\n    width: min(380px, 92vw);\n}\n\n.instafn-modal-header {\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    padding: 20px 16px;\n    border-bottom: 1px solid rgba(var(--ig-primary-text), 0.1);\n    background: rgb(var(--ig-elevated-background));\n    position: relative;\n}\n\n.instafn-header-left {\n    display: inline-flex;\n    align-items: center;\n}\n\n.instafn-close {\n    position: absolute;\n    right: 16px;\n    cursor: pointer;\n    font-size: 24px;\n    line-height: 1;\n    border: none;\n    background: transparent;\n    color: rgb(var(--ig-primary-icon));\n    width: 32px;\n    height: 32px;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    transition: color 0.2s ease;\n}\n\n.instafn-close:hover {\n    color: rgb(var(--ig-secondary-text));\n}\n\n.instafn-modal-title {\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-16-font-size);\n    color: rgb(var(--ig-primary-text));\n    font-family: var(--font-family-system);\n}\n\n.instafn-tabs {\n    display: flex;\n    gap: 0;\n    padding: 0;\n    border-bottom: 1px solid rgba(var(--ig-primary-text), 0.1);\n    background: rgb(var(--ig-elevated-background));\n    overflow-x: auto;\n    scrollbar-width: none;\n    -ms-overflow-style: none;\n    scroll-behavior: smooth;\n}\n\n.instafn-tabs::-webkit-scrollbar {\n    display: none;\n}\n\n.instafn-tab {\n    padding: 16px 20px;\n    border: none;\n    background: transparent;\n    cursor: pointer;\n    font-size: var(--system-14-font-size);\n    font-weight: var(--font-weight-system-semibold);\n    color: rgb(var(--ig-secondary-text));\n    border-bottom: 2px solid transparent;\n    white-space: nowrap;\n    font-family: var(--font-family-system);\n    transition: all 0.2s;\n}\n\n.instafn-tab.active {\n    color: rgb(var(--ig-primary-text));\n    border-bottom-color: rgb(var(--ig-primary-text));\n}\n\n.instafn-tab:hover {\n    background: rgb(var(--ig-highlight-background));\n}\n\n.instafn-content {\n    padding: 0;\n    overflow: auto;\n    max-height: 60vh;\n    background: rgb(var(--ig-elevated-background));\n}\n\n.instafn-list {\n    display: flex;\n    flex-direction: column;\n    gap: 0;\n}\n\n.instafn-item {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    padding: 12px 16px;\n    border-bottom: 1px solid rgba(var(--ig-primary-text), 0.1);\n    transition: background-color 0.2s;\n}\n\n.instafn-item:hover {\n    background: rgb(var(--ig-highlight-background));\n}\n\n.instafn-item-left {\n    display: flex;\n    align-items: center;\n    gap: 12px;\n    flex: 1;\n}\n\n.instafn-item img {\n    width: 44px;\n    height: 44px;\n    border-radius: 50%;\n    object-fit: cover;\n    background: rgb(var(--ig-secondary-background));\n}\n\n.instafn-item-info {\n    display: flex;\n    flex-direction: column;\n    gap: 2px;\n}\n\n.instafn-item-username {\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-primary-text));\n    font-family: var(--font-family-system);\n}\n\n.instafn-item-name {\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n    font-family: var(--font-family-system);\n}\n\n.instafn-item a {\n    color: inherit;\n    text-decoration: none;\n}\n\n.instafn-item a:hover {\n    text-decoration: underline;\n}\n\n.instafn-item-username a {\n    color: rgb(var(--ig-primary-text)) !important;\n}\n\n.instafn-follow-btn {\n    background: rgb(var(--ig-colors-button-primary-background));\n    color: rgb(var(--ig-colors-button-primary-text));\n    border: none;\n    border-radius: 8px;\n    padding: 7px 16px;\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-14-font-size);\n    cursor: pointer;\n    font-family: var(--font-family-system);\n    transition: background-color 0.2s;\n}\n\n.instafn-follow-btn:hover {\n    background: rgb(var(--ig-colors-button-primary-background--hover));\n}\n\n.instafn-follow-btn:active {\n    background: rgb(var(--ig-colors-button-primary-background--pressed));\n}\n\n.instafn-follow-btn:disabled {\n    background: rgb(var(--ig-colors-button-primary-background--disabled));\n    color: rgb(var(--ig-colors-button-primary-text--disabled));\n}\n\n.instafn-follow-btn.following {\n    background: rgb(var(--ig-secondary-button-background));\n    color: rgb(var(--ig-secondary-button));\n}\n\n.instafn-follow-btn.following:hover {\n    background: rgba(var(--ig-primary-text), 0.1);\n}\n\n.instafn-empty {\n    color: rgb(var(--ig-secondary-text));\n    font-style: italic;\n    text-align: center;\n    padding: 40px 20px;\n    font-size: var(--system-14-font-size);\n    font-family: var(--font-family-system);\n}\n\n.instafn-modal-description {\n    margin: 0 0 16px 0;\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n    font-family: var(--font-family-system);\n    line-height: 1.4;\n}\n\n.instafn-warning-box {\n    margin-bottom: 20px;\n    padding: 12px;\n    background: rgb(var(--ig-temporary-highlight));\n    border: 1px solid rgb(var(--ig-separator));\n    border-radius: 8px;\n    color: rgb(var(--ig-secondary-text));\n    font-size: var(--system-13-font-size);\n    font-family: var(--font-family-system);\n    line-height: 1.4;\n}\n\n.instafn-loading-text {\n    margin: 0;\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n    font-family: var(--font-family-system);\n}\n\n.instafn-error-icon {\n    margin-bottom: 20px;\n    color: rgb(var(--ig-error-or-destructive));\n    font-size: 48px;\n}\n\n.instafn-error-title {\n    margin: 0 0 12px 0;\n    font-size: var(--system-18-font-size);\n    font-weight: var(--font-weight-system-semibold);\n    color: rgb(var(--ig-primary-text));\n    font-family: var(--font-family-system);\n}\n\n.instafn-error-message {\n    margin: 0 0 24px 0;\n    font-size: var(--system-14-font-size);\n    color: rgb(var(--ig-secondary-text));\n    font-family: var(--font-family-system);\n    line-height: 1.4;\n}\n\n.instafn-primary-button {\n    background: rgb(var(--ig-colors-button-primary-background));\n    color: rgb(var(--ig-colors-button-primary-text));\n    border: none;\n    border-radius: 8px;\n    padding: 12px 24px;\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-14-font-size);\n    cursor: pointer;\n    font-family: var(--font-family-system);\n    transition: background-color 0.2s;\n}\n\n.instafn-primary-button:hover {\n    background: rgb(var(--ig-colors-button-primary-background--hover));\n}\n\n.instafn-primary-button:active {\n    background: rgb(var(--ig-colors-button-primary-background--pressed));\n}\n\n.instafn-primary-button:disabled {\n    background: rgb(var(--ig-colors-button-primary-background--disabled));\n    color: rgb(var(--ig-colors-button-primary-text--disabled));\n}\n\n.instafn-secondary-button {\n    background: rgb(var(--ig-secondary-button-background));\n    color: rgb(var(--ig-secondary-button));\n    border: none;\n    border-radius: 8px;\n    padding: 12px 24px;\n    font-weight: var(--font-weight-system-semibold);\n    font-size: var(--system-14-font-size);\n    cursor: pointer;\n    font-family: var(--font-family-system);\n    transition: background-color 0.2s;\n}\n\n.instafn-secondary-button:hover {\n    background: rgba(var(--ig-primary-text), 0.1);\n}\n\n.instafn-loading-container {\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    justify-content: center;\n    text-align: center;\n    padding: 40px 20px;\n}\n\n.instafn-loading-spinner {\n    width: 32px;\n    height: 32px;\n    margin: 0 auto 20px;\n    border: 3px solid rgb(var(--ig-separator));\n    border-top-color: rgb(var(--ig-primary-text));\n    border-radius: 50%;\n    animation: instafn-spin 0.8s linear infinite;\n}\n\n@keyframes instafn-spin {\n    to {\n        transform: rotate(360deg);\n    }\n}\n";


STYLE_SOURCES["features/branding/branding.css"] = ".instafn-link {\n  color: inherit !important;\n  text-decoration: none !important;\n  font-weight: inherit !important;\n  transition: opacity 0.2s ease !important;\n}\n\n.instafn-link:hover {\n  text-decoration: underline !important;\n}\n\n._ab8b ._ab8i {\n  text-transform: initial !important;\n}\n";


STYLE_SOURCES["features/profile-follow-indicator/profile-follow-indicator.css"] = "#instafn-follow-indicator {\n  font-size: 12px;\n  color: #8e8e8e;\n  margin: 4px 0;\n  padding: 0;\n  line-height: 1.2;\n  min-height: 14px;\n  font-weight: 600;\n}\n\n";


STYLE_SOURCES["features/call-timer/call-timer.css"] = ".instafn-call-timer {\n  color: var(--primary-text);\n  font-size: inherit;\n  font-weight: inherit;\n  display: inline-block;\n}\n\n.instafn-call-timer-separator {\n  margin: 0 4px;\n  color: var(--primary-text);\n  opacity: 0.6;\n}\n\n";


STYLE_SOURCES["features/media-downloader/media-downloader.css"] = "/* Media Downloader — injected button styles.\n *\n * Buttons blend into Instagram's own controls (transparent, currentColor icon,\n * subtle hover). Each surface gets light positioning tweaks. Everything is\n * namespaced under .instafn-dl-* so it can't leak into IG styles. */\n\n.instafn-dl-btn {\n  all: unset;\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  cursor: pointer;\n  color: inherit;\n  border-radius: 8px;\n  padding: 4px;\n  line-height: 0;\n  transition: transform 0.12s ease, opacity 0.12s ease, background 0.12s ease;\n  -webkit-tap-highlight-color: transparent;\n}\n\n.instafn-dl-btn:hover {\n  transform: scale(1.06);\n  opacity: 0.7;\n}\n\n.instafn-dl-btn:active {\n  transform: scale(0.92);\n}\n\n.instafn-dl-btn svg {\n  display: block;\n  pointer-events: none;\n}\n\n.instafn-dl-btn.instafn-dl-busy {\n  opacity: 0.85;\n  cursor: default;\n}\n\n@keyframes instafn-dl-spin {\n  to {\n    transform: rotate(360deg);\n  }\n}\n\n.instafn-dl-spin {\n  transform-origin: 50% 50%;\n  animation: instafn-dl-spin 0.7s linear infinite;\n}\n\n/* Posts, reels and stories don't use these styles: their download button is a\n * clone of IG's own Share button (see inject-common.js), so it inherits IG's\n * exact box model and needs no CSS here. A faint hover/active for the cloned\n * item keeps it feeling interactive. */\n.instafn-dl-item {\n  cursor: pointer;\n  transition: opacity 0.12s ease, transform 0.12s ease;\n}\n.instafn-dl-item:hover {\n  opacity: 0.7;\n}\n.instafn-dl-item:active {\n  transform: scale(0.92);\n}\n\n/* --- Profile picture overlay --- */\n.instafn-dl-pfp-wrap {\n  position: absolute;\n  right: -2px;\n  bottom: -2px;\n  /* Above IG's active-story ring (a canvas/SVG that otherwise covers the corner). */\n  z-index: 20;\n  opacity: 0;\n  transition: opacity 0.15s ease;\n  pointer-events: none;\n}\n.instafn-dl-pfp-wrap .instafn-dl-btn {\n  background: rgba(0, 0, 0, 0.62);\n  color: #fff;\n  padding: 5px;\n  border-radius: 50%;\n  pointer-events: auto;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);\n}\n/* Reveal whenever the avatar container — or anything nested inside it — is\n * hovered. A descendant combinator on our own anchor class (rather than a\n * direct-child selector) keeps this working when IG wraps the avatar in extra\n * nested elements, e.g. the active-story ring. */\n.instafn-dl-pfp-anchor:hover .instafn-dl-pfp-wrap,\n.instafn-dl-pfp-wrap:hover {\n  opacity: 1;\n}\n\n/* Hover state for the carousel modal's action rows (the IG _a9 rows don't carry\n * one standalone). Uses the modal component's own hover token for consistency. */\n.instafn-dl-rows > button {\n  cursor: pointer;\n  transition: background-color 0.1s ease;\n}\n.instafn-dl-rows > button:hover {\n  background: rgb(var(--ig-highlight-background, 38 38 38));\n}\n\n/* --- DM voice message --- */\n/* Small download button pinned to the voice bubble's bottom-right corner,\n * always visible. The bubble is made position:relative at inject time so this\n * lands inside it rather than being flung to the bottom-left of the full-width\n * message row. */\n.instafn-dl-audio-wrap {\n  position: absolute;\n  bottom: 9px;\n  right: 11px;\n  z-index: 6;\n  opacity: 1;\n  transition: opacity 0.12s ease;\n  pointer-events: none;\n}\n/* No filled circle — just the white glyph over the coloured voice bubble. */\n.instafn-dl-audio-wrap .instafn-dl-btn {\n  color: #fff;\n  padding: 0;\n  pointer-events: auto;\n}\n.instafn-dl-audio-wrap .instafn-dl-btn:hover {\n  opacity: 0.75;\n}\n";


STYLE_SOURCES["features/post-hover-info/post-hover-info.css"] = "/* Post Hover Info — the date is a cloned count <li>, so its text already matches\n   Instagram's like/comment styling. When our date is added we stack the whole\n   list (likes, comments, date) vertically with one even gap. */\n\nul.instafn-post-hover-ul {\n  flex-direction: column !important;\n  flex-wrap: nowrap !important;\n  align-items: center !important;\n  justify-content: center !important;\n  gap: 8px !important;\n}\n\n/* IG spaces the count items with a per-item trailing margin; zero it so the\n   column gap is the only (even) spacing. */\nul.instafn-post-hover-ul > li {\n  margin: 0 !important;\n}\n\n/* Date row reads left-to-right: [icon] [date]. */\nli.instafn-post-hover-date-item {\n  flex-direction: row !important;\n  align-items: center !important;\n  justify-content: center !important;\n  gap: 6px !important;\n}\n\n/* The cloned icon span inherits the <li>'s link-blue color; force white so the\n   calendar matches the white counts. */\n.instafn-post-hover-cal-wrap {\n  display: inline-flex !important;\n  align-items: center !important;\n  color: #fff !important;\n}\n\n.instafn-post-hover-cal {\n  display: block;\n  flex: 0 0 auto;\n  width: 22px;\n  height: 22px;\n  fill: currentColor;\n}\n";


STYLE_SOURCES["features/profile-pic-popup/profilePicPopup.css"] = ".instafn-pfp-overlay {\n    position: fixed;\n    inset: 0;\n    background: rgba(0, 0, 0, 0.86);\n    z-index: 999999;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n}\n\n.instafn-pfp-image {\n    max-width: 92vw;\n    max-height: 80vh;\n    border-radius: 0;\n    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);\n    background: #222;\n}\n\n.instafn-pfp-close {\n    position: absolute;\n    top: 32px;\n    right: 40px;\n    background: rgba(0, 0, 0, 0.6);\n    border: none;\n    padding: 8px;\n    border-radius: 50%;\n    cursor: pointer;\n    z-index: 1000001;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n}\n";


// ---- page-context scripts (run against unsafeWindow) ----

PAGE_SCRIPTS["features/message-logger/socket-sniffer.js"] = function (window) {
var XMLHttpRequest = wrapCtorForPatching(window.XMLHttpRequest), WebSocket = wrapCtorForPatching(window.WebSocket);
/**
 * WebSocket Sniffer - Injected into page context
 * This intercepts all WebSocket messages and relays them to the content script
 */

(function() {
  "use strict";

  // Idempotent: this file may be injected both as a MAIN-world content script
  // (at document_start, to win the race against Instagram opening its chat
  // socket) and via the older async script-injection path. Whichever runs first
  // wins; later runs no-op so we never double-wrap window.WebSocket.
  if (window.__instafnSocketSnifferInstalled) return;
  window.__instafnSocketSnifferInstalled = true;
  console.log("[Instafn socket-sniffer] installed; wrapping window.WebSocket");

  var OrigWebSocket = window.WebSocket;
  var callWebSocket = OrigWebSocket.apply.bind(OrigWebSocket);
  var wsAddListener = OrigWebSocket.prototype.addEventListener;
  wsAddListener = wsAddListener.call.bind(wsAddListener);

  // Old edge-chat MQTT frames carry this literal in plaintext.
  var SYNC_MARKER = "ig_message_sync";
  // The actual delta payload (both transports) is an array of objects each with
  // this key. On the newer gateway transport it lives base64-encoded inside a
  // "payload" field; on edge-chat it's plaintext JSON.
  var DELTA_MARKER = "slide_delta_processor";
  var previewBudget = {}; // url -> remaining diagnostic previews

  function bytesToPrintable(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) {
        s += String.fromCharCode(b);
      }
    }
    return s;
  }

  // Pull out the first balanced [...] that contains the delta marker. String-aware
  // so brackets inside message text don't throw off the depth count.
  function extractDeltaArray(str) {
    var start = str.indexOf("[");
    while (start !== -1) {
      var depth = 0, inStr = false, esc = false, end = -1;
      for (var i = start; i < str.length; i++) {
        var ch = str[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "[") {
          depth++;
        } else if (ch === "]") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) {
        var candidate = str.substring(start, end + 1);
        if (candidate.indexOf(DELTA_MARKER) !== -1) return candidate;
      }
      start = str.indexOf("[", start + 1);
    }
    return null;
  }

  function dbg() {
    if (window.__instafnSocketDebug) {
      console.log.apply(console, ["[Instafn socket-sniffer][extract]"].concat([].slice.call(arguments)));
    }
  }

  function isB64Char(c) {
    return (
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      (c >= 48 && c <= 57) || // 0-9
      c === 43 || // +
      c === 47 || // /
      c === 61 // =
    );
  }

  // Grab the base64 payload that follows the first `"payload":"`, up to the
  // closing quote of that JSON string. The gateway server JSON-escapes every '/'
  // in the base64 as '\/', so the run is peppered with backslashes; we collect
  // base64 chars and skip the escape backslashes, stopping at the first real
  // closing quote (base64 never contains a '"'). A plain "scan until first
  // non-base64 char" stopped at the first '\' and silently truncated every
  // new-message frame. Returns the reassembled base64 (>=16 chars) or null.
  function grabPayloadB64(printable) {
    var key = '"payload":"';
    var i = printable.indexOf(key);
    while (i !== -1) {
      var start = i + key.length;
      var b64 = "";
      var closedByQuote = false;
      for (var j = start; j < printable.length; j++) {
        var c = printable.charCodeAt(j);
        if (isB64Char(c)) {
          b64 += printable[j];
        } else if (c === 34) {
          closedByQuote = true;
          break;
        }
        // else: a JSON escape backslash (from '\/') or stray framing byte — skip.
      }
      if (b64.length >= 16) {
        return { b64: b64, closedByQuote: closedByQuote };
      }
      i = printable.indexOf(key, i + 1);
    }
    return null;
  }

  // Decode base64. A complete run (the normal case) decodes as-is — do NOT strip
  // its '=' padding, that would corrupt the final bytes. Only if atob rejects the
  // run (a genuinely truncated frame) do we trim to a 4-char boundary and decode
  // the valid prefix so we at least recover the JSON we can.
  function safeAtob(b64) {
    try {
      return atob(b64);
    } catch (e) {
      var s = b64.slice(0, b64.length - (b64.length % 4));
      try {
        return atob(s);
      } catch (e2) {
        return null;
      }
    }
  }

  // Returns the slide-delta JSON array from a frame, or null. Handles both the
  // plaintext form and the newer { "payload": "<base64>" } gateway form.
  function extractDeltaJson(printable) {
    if (printable.indexOf(DELTA_MARKER) !== -1) {
      var direct = extractDeltaArray(printable);
      if (direct) return direct;
      dbg("delta marker present in plaintext but extractDeltaArray returned null");
    }
    var hit = grabPayloadB64(printable);
    if (!hit) return null;
    var decoded = safeAtob(hit.b64);
    if (decoded === null) {
      dbg("atob failed on base64 run (len " + hit.b64.length + ")");
      return null;
    }
    if (decoded.indexOf(DELTA_MARKER) === -1) {
      // Not a delta payload (e.g. an item_ack with an object payload, which
      // grabPayloadB64 won't reach since its payload isn't a quoted string).
      return null;
    }
    var arr = extractDeltaArray(decoded);
    if (!arr) {
      dbg(
        "FRAGMENTED? decoded has delta marker but no balanced array. b64 len " +
          hit.b64.length +
          ", closedByQuote " + hit.closedByQuote +
          ", decoded len " + decoded.length
      );
    }
    return arr;
  }

  function relayFrame(url, data, dataType, printable) {
    // DIAGNOSTIC: dump the structure of every lightspeed frame so we can see how
    // a large (fragmented) new-message payload is chunked across frames. For each
    // frame: total printable length, whether it carries the {"payload":"..."}
    // envelope, the base64 run length + whether it's quote-terminated, and the
    // head/tail of that run. Send ONE message and read the consecutive frames.
    if (window.__instafnSocketDebug && url.indexOf("lightspeed") !== -1) {
      var key = '"payload":"';
      var pi = printable.indexOf(key);
      if (pi !== -1) {
        var rs = pi + key.length, rj = rs;
        while (rj < printable.length && isB64Char(printable.charCodeAt(rj))) rj++;
        // The char that broke the run, shown as its code so control chars are visible.
        var boundary = [];
        for (var k = rj; k < Math.min(rj + 8, printable.length); k++) boundary.push(printable.charCodeAt(k));
        // Count how many base64 chars exist in TOTAL after the payload start if we
        // skip every non-base64 char up to the final closing quote — i.e. does
        // collecting all segments reconstruct a complete base64 string?
        var collected = 0, sawQuote = -1;
        for (var c = rs; c < printable.length; c++) {
          var cc = printable.charCodeAt(c);
          if (isB64Char(cc)) collected++;
          else if (cc === 34) { sawQuote = c; break; }
        }
        console.log("[Instafn socket-sniffer][LS]", {
          printableLen: printable.length,
          firstRunLen: rj - rs,
          boundaryCharCodes: boundary,
          boundaryAscii: JSON.stringify(printable.slice(rj, rj + 8)),
          collectedB64UpToQuote: collected,
          quoteFoundAt: sawQuote === -1 ? "none" : (sawQuote - rs),
          payloadOccurrences: printable.split(key).length - 1,
        });
      }
    }

    // DIAGNOSTIC: when debugging deleted-message capture, dump what every frame
    // on the chat sockets looks like — which __typename(s) it carries, whether a
    // delete-ish word appears, and which marker (if any) matched. Unsend a
    // message and read these: a delete-word frame with hasDelta=false means the
    // unsend uses a transport/shape we drop here; an unfamiliar __typename with
    // hasDelta=true means the delete delta was renamed (update index.js).
    if (window.__instafnSocketDebug) {
      var dbgTypes = (printable.match(/"__typename"\s*:\s*"[^"]+"/g) || []).slice(0, 12);
      var dbgDelete = /delete|unsend|revoke|removed/i.test(printable);
      if (dbgTypes.length || dbgDelete) {
        console.log("[Instafn socket-sniffer] FRAME", {
          url: url,
          dataType: dataType,
          typenames: dbgTypes,
          deleteWord: dbgDelete,
          hasSync: printable.indexOf(SYNC_MARKER) !== -1,
          hasDelta: printable.indexOf(DELTA_MARKER) !== -1,
          preview: printable.slice(0, 400),
        });
      }
    }

    // Old edge-chat format: relay the raw frame; the parser finds ig_message_sync.
    if (printable.indexOf(SYNC_MARKER) !== -1) {
      window.postMessage(
        { source: "instafn-websocket", type: "websocket-message", url: url, data: data, dataType: dataType },
        "*"
      );
      return;
    }
    // Newer gateway format: decode/extract the delta JSON and relay it as a clean
    // string the existing parser can consume directly.
    var deltaJson = extractDeltaJson(printable);
    if (deltaJson) {
      window.postMessage(
        { source: "instafn-websocket", type: "websocket-message", url: url, data: deltaJson, dataType: "string" },
        "*"
      );
      return;
    }
    // Diagnostic: a few previews per socket for any still-unhandled format.
    // Gated behind window.__instafnSocketDebug to keep the console readable.
    var left = previewBudget[url] === undefined ? 3 : previewBudget[url];
    if (left > 0 && printable.trim().length > 0 && window.__instafnSocketDebug) {
      previewBudget[url] = left - 1;
      console.log("[Instafn socket-sniffer] frame (no marker) on " + url + ":", printable.slice(0, 220));
    }
  }

  function handleFrame(url, raw) {
    if (raw instanceof Blob) {
      var reader = new FileReader();
      reader.onload = function() {
        var u8 = new Uint8Array(reader.result);
        relayFrame(url, Array.from(u8), "Blob", bytesToPrintable(u8));
      };
      reader.readAsArrayBuffer(raw);
    } else if (raw instanceof ArrayBuffer) {
      var a8 = new Uint8Array(raw);
      relayFrame(url, Array.from(a8), "ArrayBuffer", bytesToPrintable(a8));
    } else if (raw instanceof Uint8Array) {
      relayFrame(url, Array.from(raw), "Uint8Array", bytesToPrintable(raw));
    } else if (typeof raw === "string") {
      relayFrame(url, raw, "string", raw);
    }
  }

  window.WebSocket = function WebSocket(url, protocols) {
    var ws;
    if (!(this instanceof WebSocket)) {
      // Called without 'new' (browsers will throw an error).
      ws = callWebSocket(this, arguments);
    } else if (arguments.length === 1) {
      ws = new OrigWebSocket(url);
    } else if (arguments.length >= 2) {
      ws = new OrigWebSocket(url, protocols);
    } else {
      // No arguments (browsers will throw an error)
      ws = new OrigWebSocket();
    }

    if (url && window.__instafnSocketDebug) {
      console.log("[Instafn socket-sniffer] WebSocket opened:", url);
    }

    // Hook all of Instagram's realtime sockets. DM sync has been migrating from
    // edge-chat.instagram.com onto gateway.instagram.com, so we can't hard-code
    // one host; relayFrame() filters to the message-sync frames.
    if (
      url &&
      (url.indexOf("edge-chat.instagram.com") !== -1 ||
        url.indexOf("gateway.instagram.com") !== -1)
    ) {
      wsAddListener(ws, "message", function(event) {
        try {
          handleFrame(url, event.data);
        } catch (e) {
          // Ignore malformed frames
        }
      });
    }

    return ws;
  };

  // Copy prototype and static properties
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.prototype.constructor = window.WebSocket;

  // Copy static constants
  Object.defineProperty(window.WebSocket, "CONNECTING", {
    value: OrigWebSocket.CONNECTING,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "OPEN", {
    value: OrigWebSocket.OPEN,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "CLOSING", {
    value: OrigWebSocket.CLOSING,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "CLOSED", {
    value: OrigWebSocket.CLOSED,
    writable: false,
  });
})();

};


PAGE_SCRIPTS["features/message-logger/graphql-sniffer.js"] = function (window) {
var XMLHttpRequest = wrapCtorForPatching(window.XMLHttpRequest), WebSocket = wrapCtorForPatching(window.WebSocket);
/**
 * GraphQL Sniffer - Injected into page context
 * This intercepts GraphQL requests and relays responses to the content script
 *
 * NOTE: this sniffer is shared by several features (Message Logger, Profile
 * Follow Indicator, Post Hover Info). Each forwarded message carries its own
 * flag (isProfileRequest / isPostsRequest) so consumers only react to what they
 * care about and each feature toggles on/off independently.
 * TODO: this lives under message-logger/ for historical reasons; extract it to a
 * shared location (e.g. content/lib/) so it isn't owned by one feature folder.
 */

(function() {
  "use strict";

  // Idempotent: may be injected both as a MAIN-world content script (document_start)
  // and via the older async path. Whichever runs first wins; later runs no-op.
  if (window.__instafnGraphqlSnifferInstalled) return;
  window.__instafnGraphqlSnifferInstalled = true;

  // Intercept fetch API
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const [url, options = {}] = args;

    // Check if this is a GraphQL request
    // Instagram uses multiple endpoints: /graphql/query, /api/graphql, and /ajax/bz
    if (
      typeof url === "string" &&
      (url.includes("/graphql/query") ||
        url.includes("/api/graphql") ||
        url.includes("/ajax/bz"))
    ) {
      // Get body as string
      let bodyStr = "";
      if (typeof options.body === "string") {
        bodyStr = options.body;
      } else if (options.body instanceof URLSearchParams) {
        bodyStr = options.body.toString();
      } else if (options.body instanceof FormData) {
        for (const [key, value] of options.body.entries()) {
          if (typeof value === "string") {
            bodyStr += value + " ";
          }
        }
      } else if (options.body) {
        bodyStr = String(options.body);
      }

      // Check if it's a profile page request
      // Check for various profile-related query patterns
      const isProfileRequest =
        bodyStr.includes("PolarisProfilePageContentQuery") ||
        bodyStr.includes("fetch__XDTUserDict") ||
        bodyStr.includes("PolarisProfileRoute") ||
        (url.includes("/ajax/bz") &&
          bodyStr.includes("__crn") &&
          bodyStr.includes("comet.igweb.PolarisProfileRoute"));

      // The profile grid's posts feed (each node carries a `taken_at` date that
      // Post Hover Info surfaces on hover). Flagged separately from
      // isProfileRequest so it's never mistaken for a follow-status response.
      // Match the PolarisProfilePosts* family so scroll-pagination pages are
      // captured too, not just the first PolarisProfilePostsQuery.
      const isPostsRequest =
        bodyStr.includes("PolarisProfilePosts") ||
        bodyStr.includes("xdt_api__v1__feed__user_timeline_graphql_connection");

      // Debug: log all GraphQL fetch requests
      console.log(
        "[Instafn graphql-sniffer] GraphQL fetch request:",
        url,
        "Body preview:",
        bodyStr.substring(0, 200)
      );

      if (isProfileRequest || isPostsRequest) {
        console.log(
          "[Instafn graphql-sniffer]  Intercepted profile GraphQL request (fetch):",
          url
        );
        try {
          const response = await originalFetch.apply(this, args);
          const clonedResponse = response.clone();

          try {
            const data = await clonedResponse.json();
            window.postMessage(
              {
                source: "instafn-graphql",
                type: "graphql-response",
                url: url,
                data: JSON.stringify(data),
                isProfileRequest: isProfileRequest,
                isPostsRequest: isPostsRequest,
              },
              "*"
            );
          } catch (parseErr) {
            // Try to get as text
            try {
              const text = await clonedResponse.text();
              window.postMessage(
                {
                  source: "instafn-graphql",
                  type: "graphql-response",
                  url: url,
                  data: text,
                  isProfileRequest: isProfileRequest,
                  isPostsRequest: isPostsRequest,
                },
                "*"
              );
            } catch (e) {
              console.error(
                "[Instafn graphql-sniffer] Error reading response:",
                e
              );
            }
          }

          return response;
        } catch (err) {
          console.error(
            "[Instafn graphql-sniffer] Error in fetch interceptor:",
            err
          );
        }
      }
    }

    return originalFetch.apply(this, args);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._instafnUrl = url;
    this._instafnMethod = method;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url = this._instafnUrl;
    const method = this._instafnMethod;

    // Get body as string for checking
    let bodyStr = "";
    if (typeof body === "string") {
      bodyStr = body;
    } else if (body instanceof URLSearchParams) {
      bodyStr = body.toString();
    } else if (body instanceof FormData) {
      // FormData - get all values
      for (const [key, value] of body.entries()) {
        if (typeof value === "string") {
          bodyStr += value + " ";
        }
      }
    } else if (body) {
      bodyStr = String(body);
    }

    // Check if this is an inbox GraphQL request
    const isInboxRequest =
      url &&
      ((url.includes("/ajax/bz") && url.includes("PolarisDirectInboxRoute")) ||
        (url.includes("/api/graphql") &&
          (bodyStr.includes("PolarisDirectInboxQuery") ||
            bodyStr.includes("get_slide_mailbox"))));

    // Check if this is a profile page GraphQL request
    // Instagram uses multiple endpoints: /graphql/query, /api/graphql, and /ajax/bz
    const isProfileRequest =
      url &&
      // Standard GraphQL endpoints with profile query names
      (((url.includes("/graphql/query") || url.includes("/api/graphql")) &&
        (bodyStr.includes("PolarisProfilePageContentQuery") ||
          bodyStr.includes("fetch__XDTUserDict"))) ||
        // /ajax/bz endpoint with profile-related queries (common for profile pages)
        (url.includes("/ajax/bz") &&
          (bodyStr.includes("PolarisProfilePageContentQuery") ||
            bodyStr.includes("fetch__XDTUserDict") ||
            bodyStr.includes("PolarisProfileRoute") ||
            (bodyStr.includes("__crn") &&
              bodyStr.includes("comet.igweb.PolarisProfileRoute")))));

    // The profile grid's posts feed (see fetch path above). Forwarded under its
    // own flag so Post Hover Info works whether or not the other GraphQL-based
    // features are enabled.
    const isPostsRequest =
      url &&
      (url.includes("/graphql/query") ||
        url.includes("/api/graphql") ||
        url.includes("/ajax/bz")) &&
      (bodyStr.includes("PolarisProfilePosts") ||
        bodyStr.includes("xdt_api__v1__feed__user_timeline_graphql_connection"));

    // Only log profile requests to reduce spam
    if (isProfileRequest) {
      console.log(
        "[Instafn graphql-sniffer]  Intercepted profile GraphQL request:",
        url
      );
    }

    if (isInboxRequest || isProfileRequest || isPostsRequest) {
      const originalOnReadyStateChange = this.onreadystatechange;

      this.onreadystatechange = function() {
        if (this.readyState === 4 && this.status === 200) {
          try {
            const responseText = this.responseText;
            if (responseText) {
              // Relay to content script via postMessage
              window.postMessage(
                {
                  source: "instafn-graphql",
                  type: "graphql-response",
                  url: url,
                  data: responseText,
                  isProfileRequest: isProfileRequest,
                  isPostsRequest: isPostsRequest,
                },
                "*"
              );
            }
          } catch (err) {
            // Silently fail
          }
        }

        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };

      // Also handle addEventListener for load/readystatechange
      const originalAddEventListener = this.addEventListener;
      this.addEventListener = function(type, listener, options) {
        if (type === "load" || type === "readystatechange") {
          return originalAddEventListener.call(
            this,
            type,
            function(event) {
              if (this.readyState === 4 && this.status === 200) {
                try {
                  const responseText = this.responseText;
                  if (responseText) {
                    window.postMessage(
                      {
                        source: "instafn-graphql",
                        type: "graphql-response",
                        url: url,
                        data: responseText,
                        isProfileRequest: isProfileRequest,
                        isPostsRequest: isPostsRequest,
                      },
                      "*"
                    );
                  }
                } catch (err) {
                  // Silently fail
                }
              }
              if (listener) listener.call(this, event);
            },
            options
          );
        }
        return originalAddEventListener.apply(this, arguments);
      };
    }

    return originalXHRSend.apply(this, arguments);
  };
})();

};


PAGE_SCRIPTS["features/story-blocking/storyblocking.js"] = function (window) {
var XMLHttpRequest = wrapCtorForPatching(window.XMLHttpRequest), WebSocket = wrapCtorForPatching(window.WebSocket);
(function() {
  "use strict";

  const blockPattern = /PolarisAPIReelSeenMutation|PolarisStoriesV3SeenMutation/i;
  let allowSeenUntil = 0;
  let pendingSeenRequests = []; // Store blocked seen requests
  const MAX_PENDING_REQUESTS = 10; // Keep last 10 requests
  let lastStoryUrl = window.location.href; // Track story changes

  function isBypassActive() {
    return Date.now() < allowSeenUntil;
  }

  function allowSeenFor(ms) {
    allowSeenUntil = Date.now() + Math.max(0, ms || 1500);
  }

  function storeSeenRequest(requestData) {
    // Store the request data for later replay
    pendingSeenRequests.push({
      ...requestData,
      timestamp: Date.now(),
      storyUrl: window.location.href, // Store the URL when request was captured
    });
    // Keep only the most recent requests
    if (pendingSeenRequests.length > MAX_PENDING_REQUESTS) {
      pendingSeenRequests.shift();
    }
  }

  function clearOldRequests() {
    // Clear requests that are from a different story or too old
    const currentUrl = window.location.href;
    const now = Date.now();
    pendingSeenRequests = pendingSeenRequests.filter((req) => {
      // Keep only requests from current story that are recent (within 5 seconds)
      // and haven't been used yet
      return (
        req.storyUrl === currentUrl && now - req.timestamp < 5000 && !req.used
      );
    });
  }

  function replayLatestSeenRequest() {
    // Clear old requests first
    clearOldRequests();

    // Replay the most recent seen request for the CURRENT story only
    if (pendingSeenRequests.length === 0) return false;

    const currentUrl = window.location.href;
    const now = Date.now();

    // Find the most recent unused request for the current story
    // Requests are stored in chronological order, so check from the end
    let latestRequest = null;
    for (let i = pendingSeenRequests.length - 1; i >= 0; i--) {
      const req = pendingSeenRequests[i];
      // Only consider requests from current story that are recent (within 5 seconds)
      // and haven't been used yet
      if (
        req.storyUrl === currentUrl &&
        now - req.timestamp < 5000 &&
        !req.used
      ) {
        latestRequest = req;
        break;
      }
    }

    if (!latestRequest) return false;

    // Final safety check: verify URL hasn't changed since we found the request
    // This prevents replaying if user navigated to next story between finding and replaying
    if (window.location.href !== currentUrl) {
      return false; // Story changed, don't replay
    }

    try {
      // Replay the request for the current story
      if (latestRequest.type === "xhr") {
        // Replay XHR request with captured headers
        const xhr = new XMLHttpRequest();
        xhr.open(latestRequest.method || "POST", latestRequest.url, true);
        // Set all captured headers
        if (latestRequest.headers) {
          Object.keys(latestRequest.headers).forEach((key) => {
            try {
              xhr.setRequestHeader(key, latestRequest.headers[key]);
            } catch (err) {
              // Some headers might not be settable, ignore
            }
          });
        }
        xhr.send(latestRequest.body);
      } else if (latestRequest.type === "fetch") {
        fetch(latestRequest.url, {
          method: latestRequest.method || "POST",
          headers: latestRequest.headers || {},
          body: latestRequest.body,
          credentials: "include",
          mode: "cors",
        }).catch(() => {}); // Ignore errors
      } else if (latestRequest.type === "ig-api") {
        if (window.ig?.api?.fetch) {
          window.ig.api
            .fetch(latestRequest.url, {
              method: latestRequest.method || "POST",
              headers: latestRequest.headers || {},
              body: latestRequest.body,
            })
            .catch(() => {}); // Ignore errors
        }
      }
    } catch (err) {
      console.warn("Instafn: Failed to replay seen request:", err);
      return false;
    }

    // Mark this request as used so it won't be replayed again
    latestRequest.used = true;
    return true;
  }

  // Expose API on window
  try {
    window.InstafnStory = window.InstafnStory || {};
    window.InstafnStory.allowSeenFor = allowSeenFor;
    window.InstafnStory.markCurrentAsSeen = async function() {
      // Allow seen requests to go through for longer to catch any requests Instagram sends
      allowSeenFor(5000);

      // Try multiple approaches to mark the story as seen
      const tryMarkAsSeen = () => {
        // First, try to replay a stored request
        const hadRequest = replayLatestSeenRequest();

        if (hadRequest) {
          return true;
        }

        // If no stored request, try to trigger Instagram to send one
        try {
          const storyContainer =
            document.querySelector('[role="dialog"]') ||
            document.querySelector('article[role="presentation"]') ||
            document.body;
          if (storyContainer) {
            // Trigger multiple events to encourage Instagram to send seen request
            storyContainer.dispatchEvent(
              new Event("focus", { bubbles: true, cancelable: true })
            );
            storyContainer.dispatchEvent(
              new Event("visibilitychange", { bubbles: true, cancelable: true })
            );
            storyContainer.dispatchEvent(
              new Event("mouseenter", { bubbles: true, cancelable: true })
            );

            // Try a subtle click that won't navigate
            const clickEvent = new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
              detail: 1,
              button: 0,
            });
            storyContainer.dispatchEvent(clickEvent);
          }
        } catch (err) {
          // Ignore errors
        }

        return false;
      };

      // Try immediately
      tryMarkAsSeen();

      // Try again after a short delay in case Instagram needs time to send the request
      setTimeout(() => {
        tryMarkAsSeen();
      }, 100);

      // Try one more time after a longer delay
      setTimeout(() => {
        tryMarkAsSeen();
      }, 300);

      // Disable seen requests after 500ms to prevent marking next story
      // This gives enough time for the request to go through
      setTimeout(() => {
        allowSeenUntil = 0;
      }, 500);
    };
  } catch (_) {}

  // Track story changes to clear old requests
  function checkStoryChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastStoryUrl) {
      // Story changed - immediately clear ALL old requests to prevent cross-story marking
      pendingSeenRequests = [];
      lastStoryUrl = currentUrl;
    }
  }

  // Monitor for story changes more frequently to catch changes quickly
  let urlCheckInterval = setInterval(checkStoryChange, 200);

  // Also listen to popstate events
  window.addEventListener("popstate", checkStoryChange);
  window.addEventListener("hashchange", checkStoryChange);

  // Listen for bridge messages
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "instafn") return;
    const { type, ms } = event.data;
    if (type === "ALLOW_STORY_SEEN") {
      allowSeenFor(typeof ms === "number" ? ms : 1500);
    }
    if (type === "MARK_STORY_SEEN") {
      checkStoryChange(); // Check for story change before marking
      window.InstafnStory?.markCurrentAsSeen() || allowSeenFor(2000);
    }
  });

  // Intercept XHR open to capture URL and method
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._method = method;
    this._url = url;
    this._headers = {}; // Store headers for this request
    return originalXHROpen.apply(this, arguments);
  };

  // Intercept setRequestHeader to capture headers
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (!this._headers) this._headers = {};
    this._headers[header] = value;
    return originalSetRequestHeader.apply(this, arguments);
  };

  // Block XHR requests
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (
      !isBypassActive() &&
      typeof body === "string" &&
      blockPattern.test(body)
    ) {
      // Store the request for potential replay
      try {
        storeSeenRequest({
          type: "xhr",
          url: this._url || this.responseURL || "",
          method: this._method || "POST",
          body: body,
          headers: this._headers || {},
        });
      } catch (err) {
        // Ignore storage errors
      }
      return;
    }
    return originalXHRSend.apply(this, arguments);
  };

  // Block fetch requests
  const originalFetch = window.fetch;
  window.fetch = function() {
    const args = arguments;
    try {
      const url = args[0];
      const options = args[1] || {};
      const bodyToCheck = options.body || "";
      if (
        !isBypassActive() &&
        typeof bodyToCheck === "string" &&
        blockPattern.test(bodyToCheck)
      ) {
        // Store the request for potential replay
        try {
          storeSeenRequest({
            type: "fetch",
            url: url,
            method: options.method || "POST",
            body: bodyToCheck,
            headers: options.headers || {},
          });
        } catch (err) {
          // Ignore storage errors
        }
        return new Promise(() => {});
      }
    } catch (err) {
      console.warn("Instafn: Error checking fetch body", err);
    }
    return originalFetch.apply(this, args);
  };

  // Block Instagram API calls
  if (window.ig?.api?.fetch) {
    const originalIGFetch = window.ig.api.fetch;
    window.ig.api.fetch = function(url, options) {
      if (
        !isBypassActive() &&
        typeof url === "string" &&
        (url.includes("story_seen") ||
          url.includes("reel_seen") ||
          url.includes("story_view") ||
          url.includes("reel_view"))
      ) {
        // Store the request for potential replay
        try {
          const body = options?.body || "";
          storeSeenRequest({
            type: "ig-api",
            url: url,
            method: options?.method || "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: options?.headers || {},
          });
        } catch (err) {
          // Ignore storage errors
        }
        return new Promise(() => {});
      }
      return originalIGFetch(url, options);
    };
  }
})();

};


PAGE_SCRIPTS["features/media-downloader/voice-sniffer.js"] = function (window) {
var XMLHttpRequest = wrapCtorForPatching(window.XMLHttpRequest), WebSocket = wrapCtorForPatching(window.WebSocket);
/**
 * Voice-message URL sniffer — injected into the page (MAIN world).
 *
 * Instagram's web DM runs on the Messenger/MNet GraphQL backend. A voice note's
 * playable .ogg URL is delivered only inside the thread's GraphQL response as a
 * `SlideMessageAudiosContent` node:
 *
 *   "audio_attachments":[{
 *     "attachment_fbid":"1727482385064910",        // == the waveform clip-path id
 *     "waveform_data":[...],
 *     "playable_duration_ms":4420,
 *     "attachment_cdn_url":"https://cdn.fbsbx.com/...audioclip-...ogg..."
 *   }]
 *
 * It is NOT in the REST /direct_v2/threads/ payload and not in the DOM, so we
 * passively capture it from the page's network traffic as the conversation
 * loads, then relay each { fbid -> url } pair to the content script (via
 * postMessage). The download button maps the bubble's clip-path id straight to
 * the url — no playback, no slow pagination. (See voice-source.js.)
 */

(function () {
  "use strict";

  if (window.__instafnVoiceSnifferInstalled) return;
  window.__instafnVoiceSnifferInstalled = true;

  var DEBUG = true; // temporarily on -- flip back to false once voice download is confirmed working

  // attachment_fbid then (within the same flat attachment object — the waveform
  // is a bare number array, no braces) the cdn url. URLs never contain a
  // double-quote, so [^"]+ captures the whole signed link.
  var PAIR_RE =
    /"attachment_fbid":"(\d{6,})"[^}]*?"attachment_cdn_url":"([^"]+)"/g;

  function scan(text, whence) {
    if (!text || typeof text !== "string") return;
    if (text.indexOf("attachment_cdn_url") === -1) return;

    if (DEBUG) {
      console.log(
        "[voice-sniffer] audio-bearing response via",
        whence,
        "len=",
        text.length,
        "| audioclip:",
        /audioclip|\.ogg/i.test(text),
        "| SlideMessageAudios:",
        text.indexOf("SlideMessageAudiosContent") !== -1
      );
    }

    var pairs = [];
    var m;
    PAIR_RE.lastIndex = 0;
    while ((m = PAIR_RE.exec(text)) !== null) {
      var url = m[2];
      if (/audioclip|\.ogg(\?|#|$)/i.test(url)) pairs.push({ fbid: m[1], url: url });
    }

    if (DEBUG) {
      console.log("[voice-sniffer] extracted", pairs.length, "voice pair(s)",
        pairs.map(function (p) { return p.fbid; }));
    }

    if (pairs.length) {
      try {
        window.postMessage({ source: "instafn-voice-dl", pairs: pairs }, "*");
      } catch (e) {}
    }
  }

  // Only the DM transport endpoints — not every response. The voice url was
  // confirmed on /api/graphql, and the thread traffic rides /ajax/bz (the comet
  // PolarisDirect* routes); /graphql covers the older shape. Everything else
  // (images, scripts, telemetry) is skipped, and even within these the real work
  // is gated on a cheap indexOf("attachment_cdn_url") inside scan().
  function isInteresting(url) {
    return (
      typeof url === "string" &&
      (url.indexOf("/api/graphql") !== -1 ||
        url.indexOf("/graphql") !== -1 ||
        url.indexOf("/ajax/bz") !== -1 ||
        url.indexOf("PolarisDirect") !== -1)
    );
  }

  // fetch path.
  var originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function () {
      var args = arguments;
      var first = args[0];
      var url = first && (first.url || first);
      var p = originalFetch.apply(this, args);
      if (isInteresting(url)) {
        p.then(function (res) {
          try {
            res
              .clone()
              .text()
              .then(function (t) { scan(t, "fetch " + url); })
              .catch(function () {});
          } catch (e) {}
          return res;
        }).catch(function () {});
      }
      return p;
    };
  }

  // XHR path — this is how the thread loads its messages.
  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__instafnVoiceUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (isInteresting(this.__instafnVoiceUrl)) {
      var xhr = this;
      xhr.addEventListener("load", function () {
        if (xhr.readyState !== 4) return;
        var rt = xhr.responseType;
        // responseText only exists for '' | 'text'. For json/arraybuffer/blob
        // we read .response instead (and JSON-stringify objects).
        var body = null;
        try {
          if (rt === "" || rt === "text") {
            body = xhr.responseText;
          } else if (rt === "json") {
            body = JSON.stringify(xhr.response);
          } else if (rt === "arraybuffer") {
            body = new TextDecoder("utf-8").decode(new Uint8Array(xhr.response));
          } else if (rt === "blob") {
            // async; handle separately
            xhr.response.text().then(function (t) {
              scan(t, "xhr(blob) " + xhr.__instafnVoiceUrl);
            }).catch(function () {});
            return;
          }
        } catch (e) {
          if (DEBUG)
            console.log("[voice-sniffer] body read failed; responseType=", rt, e && e.message);
        }
        if (body != null) scan(body, "xhr(" + (rt || "text") + ") " + xhr.__instafnVoiceUrl);
      });
    }
    return originalSend.apply(this, arguments);
  };

  if (DEBUG) console.log("[Instafn voice-sniffer] installed");
})();

};


PAGE_SCRIPTS["features/typing-receipt-blocker/websocket-interceptor.js"] = function (window) {
var XMLHttpRequest = wrapCtorForPatching(window.XMLHttpRequest), WebSocket = wrapCtorForPatching(window.WebSocket);
/**
 * WebSocket Interceptor for Typing Receipt Blocking
 * Injected into page context to intercept and modify WebSocket messages
 */

(function() {
  "use strict";

  // Initialize flag
  if (!window.Instafn) window.Instafn = {};
  window.Instafn.blockTypingReceipts = false;

  // Listen for messages from content script to update the flag
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data?.source === 'instafn-content' && event.data?.type === 'set-typing-blocker') {
      window.Instafn.blockTypingReceipts = event.data.enabled === true;
    }
  });

  // Always set up interceptor, but check flag dynamically in interceptSend
  // This allows toggling the feature on/off without re-injecting

  var OrigWebSocket = window.WebSocket;
  var originalPrototypeSend = OrigWebSocket.prototype.send;
  var interceptedWebSockets = new WeakSet();
  var protoTextDecoder = new TextDecoder("utf-8");
  var protoTextEncoder = new TextEncoder();

  // Intercept WebSocket constructor
  window.WebSocket = function WebSocket(url, protocols) {
    var ws;
    if (!(this instanceof WebSocket)) {
      ws = OrigWebSocket.apply(this, arguments);
    } else if (arguments.length === 1) {
      ws = new OrigWebSocket(url);
    } else if (arguments.length >= 2) {
      ws = new OrigWebSocket(url, protocols);
    } else {
      ws = new OrigWebSocket();
    }

    // Only intercept Instagram chat WebSocket
    if (url && url.includes("edge-chat.instagram.com")) {
      var textDecoder = new TextDecoder("utf-8");
      var textEncoder = new TextEncoder();
      var originalSend = OrigWebSocket.prototype.send;

      ws.send = function(data) {
        return interceptSend(data, originalSend, textDecoder, textEncoder, this);
      };
    }

    return ws;
  };

  // Copy prototype and static properties
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.prototype.constructor = window.WebSocket;

  // Intercept at prototype level to catch WebSockets created before our script runs
  OrigWebSocket.prototype.send = function(data) {
    // Only intercept Instagram chat WebSockets
    if (this.url && this.url.includes("edge-chat.instagram.com")) {
      interceptedWebSockets.add(this);
      return interceptSend(data, originalPrototypeSend, protoTextDecoder, protoTextEncoder, this);
    }

    // Not an Instagram chat WebSocket, use original send
    return originalPrototypeSend.call(this, data);
  };

  // Re-apply our send interception since copying the prototype overwrote it
  window.WebSocket.prototype.send = OrigWebSocket.prototype.send;

  // Copy static constants
  Object.defineProperty(window.WebSocket, "CONNECTING", {
    value: OrigWebSocket.CONNECTING,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "OPEN", {
    value: OrigWebSocket.OPEN,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "CLOSING", {
    value: OrigWebSocket.CLOSING,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "CLOSED", {
    value: OrigWebSocket.CLOSED,
    writable: false,
  });

  // Core interception function
  function interceptSend(data, originalSend, decoder, encoder, context) {
    // Check if still enabled (in case setting was toggled)
    var isEnabled = window.Instafn?.blockTypingReceipts === true;
    if (!isEnabled) {
      // Not enabled, pass through
      return originalSend.call(context, data);
    }
    // Typing receipts are tiny (<500 bytes). Skip all processing for larger messages.
    var messageSize = 0;
    if (typeof data === "string") {
      messageSize = data.length;
    } else if (data instanceof ArrayBuffer) {
      messageSize = data.byteLength;
    } else if (data instanceof Uint8Array) {
      messageSize = data.length;
    } else {
      // Blob or unknown type - pass through immediately
      return originalSend.call(context, data);
    }

    // Skip processing for messages larger than 500 bytes (not typing receipts)
    if (messageSize > 500) {
      return originalSend.call(context, data);
    }

    // For strings, quick check before processing
    if (typeof data === "string") {
      if (!data.includes("is_typing")) {
        return originalSend.call(context, data);
      }
      // Only process if is_typing found
      var modifiedStr = data
        .replace(/(\\+)"is_typing(\\+)"\s*:\s*\d+/g, function(match, bs1, bs2) {
          return bs1 + '"is_typing' + bs2 + '":0';
        })
        .replace(/"is_typing"\s*:\s*\d+/g, '"is_typing":0')
        .replace(/is_typing\s*:\s*\d+/g, "is_typing:0");
      return originalSend.call(context, modifiedStr !== data ? modifiedStr : data);
    }

    // For binary, do quick byte search BEFORE decoding (much faster)
    // Only search first 200 bytes - typing receipts are small and is_typing is near start
    var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    var searchLimit = Math.min(messageSize - 9, 200);
    var found = false;
    // Quick byte search for "is_typing" (105, 115, 95, 116, 121, 112, 105, 110, 103)
    for (var i = 0; i <= searchLimit; i++) {
      if (
        bytes[i] === 105 &&
        bytes[i + 1] === 115 &&
        bytes[i + 2] === 95 &&
        bytes[i + 3] === 116 &&
        bytes[i + 4] === 121 &&
        bytes[i + 5] === 112 &&
        bytes[i + 6] === 105 &&
        bytes[i + 7] === 110 &&
        bytes[i + 8] === 103
      ) {
        found = true;
        break;
      }
    }

    // Only decode if we found is_typing
    if (!found) {
      return originalSend.call(context, data);
    }

    // Only decode if we found is_typing
    var dataStr = decoder.decode(bytes);

    // Process if is_typing is found
    if (dataStr.includes("is_typing")) {
      var modifiedStr = dataStr
        .replace(/(\\+)"is_typing(\\+)"\s*:\s*\d+/g, function(match, bs1, bs2) {
          return bs1 + '"is_typing' + bs2 + '":0';
        })
        .replace(/"is_typing"\s*:\s*\d+/g, '"is_typing":0')
        .replace(/is_typing\s*:\s*\d+/g, "is_typing:0");

      if (modifiedStr !== dataStr) {
        var encoded = encoder.encode(modifiedStr);
        return originalSend.call(
          context,
          data instanceof ArrayBuffer ? encoded.buffer : encoded
        );
      }
    }

    return originalSend.call(context, data);
  }
})();


};


// ---- vendored feature modules ----

defineModule("content.js", function (module, exports, require) {
var { scanFollowersAndFollowing, fetchUserInfo, injectScanButton, removeScanButton, openModal, createFollowButton, renderScanButton, confirmWithModal, initFollowAnalyzerEarly, setupScanButtonObserver, setScanButtonEnabled } = require("features/follow-analyzer/index.js");
var { isOwnProfile, getMeCached } = require("features/follow-analyzer/logic.js");
var { injectScript } = require("utils/scriptInjector.js");
var { watchUrlChanges } = require("utils/domObserver.js");
var { initVideoScrubber } = require("features/video-scrubber/videoScrubber.js");
var { initReelSpeedHold } = require("features/reel-speed-hold/index.js");
var { initCarouselDotDrag } = require("features/carousel-dot-drag/index.js");
var { injectProfilePicPopupOverlay } = require("features/profile-pic-popup/index.js");
var { initHideRecentSearches } = require("features/search-cleaner/index.js");
var { initHideSuggested } = require("features/hide-suggested/index.js");
var { initTabDisabler, initTabDisablerEarly } = require("features/tab-disabler/index.js");
var { enableDMDebug } = require("features/dm-popup-hider/index.js");
var { initBranding } = require("features/branding/index.js");
var { initDMThemeDebug } = require("features/dm-theme-debug/index.js");
var { initManualStorySeenButton } = require("features/story-blocking/manualSeenButton.js");
var { initExactTimeDisplay } = require("features/exact-time-display/index.js");
var { initMessageEditShortcut } = require("features/message-edit-shortcut/index.js");
var { initMessageDoubleTapLike } = require("features/message-double-tap-like/index.js");
var { initMessageLogger } = require("features/message-logger/index.js");
var { setupMessageViewer } = require("features/message-logger/message-viewer.js");
var { initTypingReceiptBlocker } = require("features/typing-receipt-blocker/index.js");
var { initProfileFollowIndicator, setupGraphQLMessageListenerEarly } = require("features/profile-follow-indicator/index.js");
var { initCallTimer } = require("features/call-timer/index.js");
var { initPostHoverInfo, setupPostHoverInfoEarly } = require("features/post-hover-info/index.js");
var { initProfileGridColumns, refreshProfileGridColumns } = require("features/profile-grid-columns/index.js");
var { initMediaDownloader, updateMediaDownloaderSettings } = require("features/media-downloader/index.js");
var { DOWNLOAD_DEFAULTS } = require("features/media-downloader/config.js");
var { initChangelog } = require("features/changelog/index.js");

// Inject the WebSocket sniffer as early as possible (this content script runs at
// document_start) so window.WebSocket is wrapped before Instagram opens its
// realtime sockets. This MUST be a src-based <script> — Instagram's page CSP
// forbids inline scripts — which injectScript() does, and chrome-extension:// is
// allowed by their script-src. The sniffer is idempotent, so the later
// settings-gated injection is a harmless no-op.
injectScript("content/features/message-logger/socket-sniffer.js");

// Inject the DM voice-note sniffer at document_start too, so its fetch/XHR
// wrappers are in place before Instagram loads a conversation (a thread's
// message fetch can fire before the media-downloader feature initializes). It
// only captures voice .ogg urls and is idempotent + harmless when the downloader
// is off.
injectScript("content/features/media-downloader/voice-sniffer.js");

// Initialize user info cache
window.userInfoCache = new Map();

// Initialize global Instafn object immediately (before DOMContentLoaded)
window.Instafn = window.Instafn || {};

// Expose getCurrentUser for message logger
window.Instafn.getCurrentUser = async () => {
  const me = await getMeCached();
  return me ? { username: me.username, userId: me.userId } : null;
};

// Add enableDMDebug placeholder (will be replaced when module loads)
window.Instafn.enableDMDebug = function() {
  console.log(
    "[Instafn] DM debug function not yet loaded. Please wait a moment and try again, or reload the page."
  );
};

// Wait until the DOM is ready for other features
document.addEventListener("DOMContentLoaded", () => {
  // Show the "What's New" changelog if the extension just updated. Always runs
  // (not gated on a feature toggle) so users see release notes after an update.
  try {
    initChangelog();
  } catch (err) {
    console.error("Instafn: Error initializing changelog:", err);
  }

  // Load user settings
  chrome.storage.sync.get(
    {
      blockStorySeen: false,
      enableManualMarkAsSeen: false,
      activateFollowAnalyzer: false,
      enableVideoScrubber: false,
      enableReelSpeedHold: true,
      enableCarouselDotDrag: false,
      enableProfilePicPopup: false,
      enableHighlightPopup: false,
      enableProfileFollowIndicator: false,
      blockTypingReceipts: false,
      hideRecentSearches: false,
      disableTabSearch: false,
      disableTabExplore: false,
      disableTabReels: false,
      disableTabMessages: false,
      disableTabNotifications: false,
      disableTabCreate: false,
      disableTabMoreFromMeta: false,
      enableMessageEditShortcut: false,
      enableMessageReplyShortcut: false,
      enableMessageDoubleTapLike: false,
      enableMessageLogger: false,
      enableDMBackground: false,
      showExactTime: false,
      timeFormat: "{M}/{D}/{YY}, {h}:{mm} {A}",
      enableCallTimer: false,
      enablePostHoverInfo: false,
      postHoverDateFormat: "{M}/{D}/{YY}",
      profileGridColumns: "default",
      ...DOWNLOAD_DEFAULTS,
    },
    (settings) => {
      if (settings.blockTypingReceipts) initTypingReceiptBlocker(true);
      if (settings.enableManualMarkAsSeen) initManualStorySeenButton(true);

      // Initialize video scrubber
      initVideoScrubber(settings.enableVideoScrubber);
      // Initialize reel 2× hold-to-fast-forward
      initReelSpeedHold(settings.enableReelSpeedHold);
      // Initialize carousel dot drag-to-scrub
      initCarouselDotDrag(settings.enableCarouselDotDrag);
      // Enable profile pic popup and highlight popup
      injectProfilePicPopupOverlay(
        settings.enableProfilePicPopup,
        settings.enableHighlightPopup
      );

      // Hide recent searches in the search overlay if enabled
      initHideRecentSearches(settings.hideRecentSearches);

      // (Home sidebar declutter — suggestions, footer, full sidebar — is
      // initialized early, before DOMContentLoaded, to avoid any flash.)

      // Initialize tab disabler
      initTabDisabler(settings);

      // Initialize DM background. Reads the chat's theme straight from the
      // rendered sent-message bubbles (no sniffers needed) and paints it as a
      // subtle background behind the conversation.
      if (settings.enableDMBackground) {
        initDMThemeDebug();
      }

      // Initialize exact time display
      initExactTimeDisplay(
        settings.showExactTime,
        settings.timeFormat || "{M}/{D}/{YY}, {h}:{mm} {A}"
      );

      // Initialize message edit and reply shortcuts (checks settings internally)
      if (
        settings.enableMessageEditShortcut ||
        settings.enableMessageReplyShortcut
      ) {
        initMessageEditShortcut();
      }

      // Initialize message double-tap to like
      if (settings.enableMessageDoubleTapLike) {
        initMessageDoubleTapLike();
      }

      // Initialize message logger
      if (settings.enableMessageLogger) {
        initMessageLogger();
        setupMessageViewer();
      }

      // Initialize profile follow indicator
      if (settings.enableProfileFollowIndicator) {
        initProfileFollowIndicator();
      }

      // Initialize call timer
      if (settings.enableCallTimer) {
        try {
          initCallTimer(true);
        } catch (err) {
          console.error("Instafn: Error initializing call timer:", err);
        }
      }

      // Initialize post hover info (date beside like/comment counts on the grid)
      if (settings.enablePostHoverInfo) {
        try {
          initPostHoverInfo(true, settings.postHoverDateFormat || "{M}/{D}/{YY}");
        } catch (err) {
          console.error("Instafn: Error initializing post hover info:", err);
        }
      }

      // Apply the profile grid column count (default 3 leaves IG untouched)
      try {
        initProfileGridColumns(settings.profileGridColumns);
      } catch (err) {
        console.error("Instafn: Error initializing profile grid columns:", err);
      }

      // Initialize media downloader (download buttons on posts, reels, stories,
      // profile pics and DM voice messages). Self-gates on its master toggle.
      try {
        initMediaDownloader(settings);
      } catch (err) {
        console.error("Instafn: Error initializing media downloader:", err);
      }

      // Initialize follow analyzer button injection (same pattern as profile comments)
      if (settings.activateFollowAnalyzer) {
        try {
          setScanButtonEnabled(true);
          injectScanButton();
          setTimeout(() => injectScanButton(), 500);
          setTimeout(() => injectScanButton(), 1500);
          setTimeout(() => injectScanButton(), 3000);
        } catch (err) {
          console.error("Instafn: Error initializing follow analyzer:", err);
        }
      }
    }
  );
});

// Initialize branding (always enabled)
initBranding();

// Inject story blocking script only if feature is enabled
chrome.storage.sync.get({ blockStorySeen: false }, (settings) => {
  if (settings.blockStorySeen) {
    injectScript("content/features/story-blocking/storyblocking.js");
  }
});

// Inject WebSocket sniffer into page context only if message logger is enabled
// This needs to happen early to catch WebSocket connections
chrome.storage.sync.get({ enableMessageLogger: false }, (settings) => {
  if (settings.enableMessageLogger) {
    injectScript("content/features/message-logger/socket-sniffer.js");
    injectScript("content/features/message-logger/graphql-sniffer.js");
  }
});

// Inject GraphQL sniffer if follow indicator is enabled (it needs GraphQL interception)
// Check both message logger and follow indicator settings
chrome.storage.sync.get(
  { enableMessageLogger: false, enableProfileFollowIndicator: false },
  (settings) => {
    if (
      settings.enableProfileFollowIndicator &&
      !settings.enableMessageLogger
    ) {
      // Only inject GraphQL sniffer if follow indicator is enabled but message logger is not
      // (if message logger is enabled, it's already injected above)
      injectScript("content/features/message-logger/graphql-sniffer.js");
    }
  }
);

// Inject the GraphQL sniffer + attach the listener early if post hover info is
// enabled, so the feature works on its own (independent of message logger and
// the follow indicator). injectScript dedupes by path, so this is a harmless
// no-op when another feature already injected the sniffer.
chrome.storage.sync.get({ enablePostHoverInfo: false }, (settings) => {
  if (settings.enablePostHoverInfo) {
    injectScript("content/features/message-logger/graphql-sniffer.js");
    setupPostHoverInfoEarly();
  }
});

// Initialize typing receipt blocker early (before DOMContentLoaded)
// This needs to happen early to catch WebSocket connections
// Only initialize if enabled
chrome.storage.sync.get({ blockTypingReceipts: false }, (settings) => {
  if (settings.blockTypingReceipts) {
    initTypingReceiptBlocker(settings.blockTypingReceipts);
  }
});

// Message logger initialization is done in DOMContentLoaded based on settings

// Initialize follow analyzer early to prevent flash (before DOMContentLoaded)
// Only initialize if enabled
chrome.storage.sync.get({ activateFollowAnalyzer: false }, (settings) => {
  if (settings.activateFollowAnalyzer) {
    initFollowAnalyzerEarly();
  }
});

// Set up profile follow indicator message listener early (before DOMContentLoaded)
// This ensures we catch GraphQL responses even on fast refreshes
// Only set up if the feature is enabled
chrome.storage.sync.get({ enableProfileFollowIndicator: false }, (settings) => {
  if (settings.enableProfileFollowIndicator) {
    setupGraphQLMessageListenerEarly();
  }
});

// Message logger initialization is done in DOMContentLoaded based on settings

// Initialize tab disabler early to prevent flash (before DOMContentLoaded)
chrome.storage.sync.get(
  {
    disableTabSearch: false,
    disableTabExplore: false,
    disableTabReels: false,
    disableTabMessages: false,
    disableTabNotifications: false,
    disableTabCreate: false,
    disableTabMoreFromMeta: false,
  },
  (settings) => {
    initTabDisablerEarly(settings);
  }
);

// Declutter the home sidebar early (before DOMContentLoaded) so suggestions,
// footer, or the whole right column never flash in or shift the layout.
chrome.storage.sync.get(
  {
    hideSuggestedProfiles: false,
    hideSuggestedAccountsOnProfile: false,
    hideHomeFooter: false,
    hideRightSidebar: false,
    hideStoriesTray: false,
    hideNotesTray: false,
  },
  (settings) => {
    initHideSuggested(
      settings.hideSuggestedProfiles,
      settings.hideSuggestedAccountsOnProfile,
      settings.hideHomeFooter,
      settings.hideRightSidebar,
      settings.hideStoriesTray,
      settings.hideNotesTray
    );
  }
);

// Listen for messages from the bridge script
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.source !== "instafn") return;

  if (event.data.type === "SCAN_FOLLOWERS") {
    try {
      await scanFollowersAndFollowing();
    } catch (err) {
      console.error("Instafn: Scan failed:", err);
      alert("Scan failed: " + err.message);
    }
  }
});

// Inject scan button on navigation (same pattern as profile comments)
// Only if feature is enabled
function checkAndInjectScanButton() {
  chrome.storage.sync.get({ activateFollowAnalyzer: false }, (settings) => {
    if (!settings.activateFollowAnalyzer) {
      removeScanButton();
      return;
    }

    const path = window.location.pathname;
    const isProfilePage = path.match(/^\/([^\/]+)\/?$/);

    if (!isProfilePage) {
      removeScanButton();
      return;
    }

    // injectScanButton() will check if it's own profile synchronously
    injectScanButton();
    setTimeout(injectScanButton, 500);
    setTimeout(injectScanButton, 1500);
    setTimeout(injectScanButton, 3000);
  });
}

// Check for profile pages on navigation
watchUrlChanges(() => {
  checkAndInjectScanButton();
  // Re-evaluate the grid column override (engages on profile pages, disengages
  // elsewhere).
  try {
    refreshProfileGridColumns();
  } catch (err) {
    console.error("Instafn: Error refreshing profile grid columns:", err);
  }
});

// Initial check
checkAndInjectScanButton();

// Set up DOM observer to watch for button container changes (similar to profile
// comments). Enable + attach this as early as possible (at document_start, off
// the first async storage read) rather than waiting for DOMContentLoaded — so
// the moment Instagram paints the profile header the observer can inject the
// button synchronously in the same frame, instead of the button popping in late
// (via the setTimeout fallbacks) and shifting the button row.
chrome.storage.sync.get({ activateFollowAnalyzer: false }, (settings) => {
  if (settings.activateFollowAnalyzer) {
    setScanButtonEnabled(true);
    setupScanButtonObserver();
    injectScanButton();
  }
});

// Listen for storage changes to update video scrubber and search cleaner
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync" && changes.enableVideoScrubber) {
    initVideoScrubber(changes.enableVideoScrubber.newValue);
  }
  if (namespace === "sync" && changes.enableReelSpeedHold) {
    initReelSpeedHold(changes.enableReelSpeedHold.newValue);
  }
  if (namespace === "sync" && changes.enableCarouselDotDrag) {
    initCarouselDotDrag(changes.enableCarouselDotDrag.newValue);
  }
  if (namespace === "sync" && changes.hideRecentSearches) {
    initHideRecentSearches(changes.hideRecentSearches.newValue);
  }
  if (
    namespace === "sync" &&
    (changes.hideSuggestedProfiles ||
      changes.hideSuggestedAccountsOnProfile ||
      changes.hideHomeFooter ||
      changes.hideRightSidebar ||
      changes.hideStoriesTray ||
      changes.hideNotesTray)
  ) {
    chrome.storage.sync.get(
      {
        hideSuggestedProfiles: false,
        hideSuggestedAccountsOnProfile: false,
        hideHomeFooter: false,
        hideRightSidebar: false,
        hideStoriesTray: false,
        hideNotesTray: false,
      },
      (settings) => {
        initHideSuggested(
          settings.hideSuggestedProfiles,
          settings.hideSuggestedAccountsOnProfile,
          settings.hideHomeFooter,
          settings.hideRightSidebar,
          settings.hideStoriesTray,
          settings.hideNotesTray
        );
      }
    );
  }
  if (namespace === "sync" && changes.blockStorySeen) {
    if (changes.blockStorySeen.newValue) {
      // Inject story blocking script if enabling
      injectScript("content/features/story-blocking/storyblocking.js");
    }
  }
  if (namespace === "sync" && changes.enableManualMarkAsSeen) {
    initManualStorySeenButton(changes.enableManualMarkAsSeen.newValue);
  }
  if (namespace === "sync" && changes.blockTypingReceipts) {
    initTypingReceiptBlocker(changes.blockTypingReceipts.newValue);
  }
  // Handle follow analyzer settings changes
  if (namespace === "sync" && changes.activateFollowAnalyzer) {
    setScanButtonEnabled(changes.activateFollowAnalyzer.newValue);
    if (changes.activateFollowAnalyzer.newValue) {
      injectScanButton();
      setTimeout(() => injectScanButton(), 500);
      setTimeout(() => injectScanButton(), 1500);
      setTimeout(() => injectScanButton(), 3000);
    }
  }
  // Handle exact time display settings changes
  if (namespace === "sync" && (changes.showExactTime || changes.timeFormat)) {
    chrome.storage.sync.get(
      { showExactTime: true, timeFormat: "{M}/{D}/{YY}, {h}:{mm} {A}" },
      (settings) => {
        initExactTimeDisplay(
          settings.showExactTime,
          settings.timeFormat || "{M}/{D}/{YY}, {h}:{mm} {A}"
        );
      }
    );
  }
  // Handle post hover info toggle and re-render when its date format changes
  if (
    namespace === "sync" &&
    (changes.enablePostHoverInfo || changes.postHoverDateFormat)
  ) {
    chrome.storage.sync.get(
      { enablePostHoverInfo: false, postHoverDateFormat: "{M}/{D}/{YY}" },
      (settings) => {
        if (settings.enablePostHoverInfo) {
          injectScript("content/features/message-logger/graphql-sniffer.js");
          setupPostHoverInfoEarly();
        }
        initPostHoverInfo(
          settings.enablePostHoverInfo,
          settings.postHoverDateFormat || "{M}/{D}/{YY}"
        );
      }
    );
  }
  // Handle profile grid column count changes
  if (namespace === "sync" && changes.profileGridColumns) {
    try {
      initProfileGridColumns(changes.profileGridColumns.newValue);
    } catch (err) {
      console.error("Instafn: Error updating profile grid columns:", err);
    }
  }
  // Handle media downloader settings changes (master toggle + per-surface)
  if (namespace === "sync") {
    const downloaderKeys = Object.keys(DOWNLOAD_DEFAULTS);
    if (downloaderKeys.some((key) => key in changes)) {
      chrome.storage.sync.get(DOWNLOAD_DEFAULTS, (settings) => {
        try {
          updateMediaDownloaderSettings(settings);
        } catch (err) {
          console.error("Instafn: Error updating media downloader:", err);
        }
      });
    }
  }
  // Handle tab disabler settings changes
  if (namespace === "sync") {
    const tabDisablerKeys = [
      "disableTabSearch",
      "disableTabExplore",
      "disableTabReels",
      "disableTabMessages",
      "disableTabNotifications",
      "disableTabCreate",
      "disableTabMoreFromMeta",
    ];
    if (tabDisablerKeys.some((key) => key in changes)) {
      chrome.storage.sync.get(
        {
          disableTabSearch: false,
          disableTabExplore: false,
          disableTabReels: false,
          disableTabMessages: false,
          disableTabNotifications: false,
          disableTabCreate: false,
          disableTabMoreFromMeta: false,
        },
        (settings) => {
          initTabDisablerEarly(settings);
          initTabDisabler(settings);
        }
      );
    }
    // Handle message logger settings changes
    if (changes.enableMessageLogger) {
      if (changes.enableMessageLogger.newValue) {
        // Inject scripts if enabling
        injectScript("content/features/message-logger/socket-sniffer.js");
        injectScript("content/features/message-logger/graphql-sniffer.js");
        initMessageLogger();
        setupMessageViewer();
      }
    }
    // Handle profile follow indicator settings changes
    if (changes.enableProfileFollowIndicator) {
      if (changes.enableProfileFollowIndicator.newValue) {
        initProfileFollowIndicator();
      }
    }
    // Handle call timer settings changes
    if (changes.enableCallTimer) {
      try {
        initCallTimer(changes.enableCallTimer.newValue);
      } catch (err) {
        console.error("Instafn: Error updating call timer:", err);
      }
    }
  }
});

// Export functions for global access (add to existing object)
Object.assign(window.Instafn, {
  scanFollowers: scanFollowersAndFollowing,
  injectScanButton,
  openModal,
  createFollowButton,
  fetchUserInfo,
  renderScanButton,
  confirmWithModal,
  enableDMDebug, // Debug function for DM popup hider
});

});


defineModule("features/profile-pic-popup/index.js", function (module, exports, require) {
var { injectStylesheet } = require("utils/styleLoader.js");

const ensureStyles = () =>
  injectStylesheet(
    "content/features/profile-pic-popup/profilePicPopup.css",
    "instafn-pfp-popup"
  );

let listenersAdded = false;
let timer, startX, startY, cancelled;
let lastTarget = null;
let overlayActive = false;
const PRESS_MS = 250;

// Settings
let enableProfilePicPopup = true;
let enableHighlightPopup = true;

function isMainProfilePicImg(img) {
  if (!img?.tagName || img.tagName !== "IMG") return false;

  // Only work on profile pages
  if (!getProfileUsernameFromLocation()) return false;

  // Must be inside a header tag
  if (!img.closest("header")) return false;

  // Check if it's the main profile picture based on alt text only
  const alt = img.alt || "";

  // Look for the main profile picture in alt text
  const isMainProfilePic = /profile picture/i.test(alt);

  return isMainProfilePic;
}

function isHighlightImg(img) {
  if (!img?.tagName || img.tagName !== "IMG") return false;

  // Only work on profile pages
  if (!getProfileUsernameFromLocation()) return false;

  // Must be inside a header tag
  if (!img.closest("header")) return false;

  // Check if it's a highlight image based on alt text only
  const alt = img.alt || "";

  // Look for highlight story picture in alt text
  const isHighlight = /highlight story picture/i.test(alt);

  return isHighlight;
}

// Returns username from /username/ profile page or null if not profile page
function getProfileUsernameFromLocation() {
  const m = window.location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
  return m ? m[1] : null;
}

// Helper function to create and show the image modal
function createImageModal(imageSrc, imageAlt) {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.className = "instafn-pfp-overlay";
  overlay.tabIndex = -1;

  const imgEl = document.createElement("img");
  imgEl.src = imageSrc;
  imgEl.alt = imageAlt;
  imgEl.className = "instafn-pfp-image";

  const closeBtn = document.createElement("button");
  closeBtn.className = "instafn-pfp-close";
  closeBtn.innerHTML =
    '<svg width="32" height="32" fill="white" style="pointer-events:none" viewBox="0 0 24 24"><path d="M6 6L18 18M6 18L18 6" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>';
  closeBtn.setAttribute("aria-label", "Close");

  function removeOverlay() {
    overlayActive = false;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key === "Escape") removeOverlay();
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) removeOverlay();
  });
  closeBtn.addEventListener("click", removeOverlay);
  document.addEventListener("keydown", onKey, true);

  overlay.appendChild(imgEl);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

// Helper function to get actual image dimensions
function getImageDimensions(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
}

async function showImageModal(img) {
  if (overlayActive) return;
  overlayActive = true;

  const originalSrc = img.src;
  const isHighlight = isHighlightImg(img);

  // For highlight images, just use the original src directly
  if (isHighlight) {
    createImageModal(originalSrc, img.alt || "Highlight story picture");
    return;
  }

  // For profile pictures, check actual image dimensions first
  const dimensions = await getImageDimensions(originalSrc);
  const actualSize = Math.max(dimensions.width, dimensions.height);

  let hdUrl = null;
  let shouldFetchHD = false;

  // Determine if we need to fetch HD based on actual image size
  if (actualSize < 1000) {
    // Image is smaller than 1000px, try to fetch HD version
    shouldFetchHD = true;
  } else if (actualSize >= 1000) {
    // Image is already high quality, use original
    createImageModal(originalSrc, img.alt || "Profile picture");
    return;
  }

  // Fetch HD version if needed
  if (shouldFetchHD) {
    const profileUsername = getProfileUsernameFromLocation();
    if (profileUsername) {
      try {
        // Use REST API to get profile info
        const resp = await fetch(
          `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
            profileUsername
          )}`,
          {
            credentials: "include",
            headers: {
              "X-IG-App-ID": "936619743392459",
              "X-Requested-With": "XMLHttpRequest",
            },
          }
        );
        if (resp.ok) {
          const userInfo = await resp.json();
          const hd = userInfo?.data?.user?.profile_pic_url_hd;
          if (hd) hdUrl = hd;
        }
      } catch (err) {
        /* ignore */
      }
    }
  }

  // Use HD URL if available, otherwise fall back to original
  const finalSrc = hdUrl || originalSrc;
  createImageModal(finalSrc, img.alt || "Profile picture");
}

function handlePointerDown(e) {
  if (!getProfileUsernameFromLocation()) return;
  if (overlayActive) return;
  if (e.target.closest && e.target.closest(".instafn-pfp-overlay")) return;
  const img = e.target;

  // Check if it's a profile pic or highlight image
  const isProfilePic = isMainProfilePicImg(img);
  const isHighlight = isHighlightImg(img);

  // Check if the respective feature is enabled
  if (
    (isProfilePic && !enableProfilePicPopup) ||
    (isHighlight && !enableHighlightPopup)
  )
    return;
  if (!isProfilePic && !isHighlight) return;

  // Prevent default behavior to avoid scrolling
  e.preventDefault();
  e.stopPropagation();

  startX = e.clientX;
  startY = e.clientY;
  cancelled = false;
  lastTarget = img;
  timer = setTimeout(() => {
    if (!cancelled && lastTarget === img) {
      showImageModal(img);
    }
  }, PRESS_MS);
}

function handlePointerUp() {
  clearTimeout(timer);
  lastTarget = null;
  cancelled = true;
}

function handlePointerMove(e) {
  if (!lastTarget) return;
  if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
    cancelled = true;
    clearTimeout(timer);
    lastTarget = null;
  }
}

function injectProfilePicPopupOverlay(
  enableProfilePicPopupParam,
  enableHighlightPopupParam = false
) {
  // Update settings
  enableProfilePicPopup = enableProfilePicPopupParam;
  enableHighlightPopup = enableHighlightPopupParam;

  if (!enableProfilePicPopup && !enableHighlightPopup) {
    // Remove listeners if both features are disabled
    if (listenersAdded) {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointerleave", handlePointerUp, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("mouseover", handleMouseOver, true);
      listenersAdded = false;
    }
    return;
  }

  // Only add listeners once
  if (!listenersAdded) {
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointerleave", handlePointerUp, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("mouseover", handleMouseOver, true);
    listenersAdded = true;
  }
}

function handleMouseOver(e) {
  const img = e.target;
  const isProfilePic = isMainProfilePicImg(img);
  const isHighlight = isHighlightImg(img);

  if (
    (isProfilePic && enableProfilePicPopup) ||
    (isHighlight && enableHighlightPopup)
  ) {
    img.style.cursor = "pointer";
  }
}


module.exports.injectProfilePicPopupOverlay = injectProfilePicPopupOverlay;
});


defineModule("features/tab-disabler/index.js", function (module, exports, require) {
// Tab disabler: Hide/disable navigation tabs based on user settings

let isEnabled = false;
let disabledTabs = new Set();
let observer = null;
let injectedStyleElement = null;

const TAB_RULES = [
  {
    key: "search",
    match: ({ href, ariaLabel, text }) =>
      (href === "#" || href === "/") &&
      (ariaLabel === "Search" || text === "search"),
  },
  {
    key: "explore",
    match: ({ href, ariaLabel, text }) =>
      href === "/explore/" || ariaLabel === "Explore" || text === "explore",
  },
  {
    key: "reels",
    match: ({ href, ariaLabel, text }) =>
      href === "/reels/" || ariaLabel === "Reels" || text === "reels",
  },
  {
    key: "messages",
    match: ({ href, ariaLabel, text }) =>
      href?.includes("/direct/inbox/") ||
      (ariaLabel && ariaLabel.toLowerCase().includes("direct messaging")) ||
      text === "messages",
  },
  {
    key: "notifications",
    match: ({ href, ariaLabel, text }) => {
      // Exclude messages tab - it has "direct messaging" in aria-label
      if (ariaLabel && ariaLabel.toLowerCase().includes("direct messaging")) {
        return false;
      }
      // Exclude messages tab - it has "messages" in text
      if (text && text.toLowerCase().includes("messages")) {
        return false;
      }
      // Must have notifications as the primary label, and href should be # or empty
      const hasNotificationsLabel =
        ariaLabel === "Notifications" ||
        (ariaLabel && ariaLabel.toLowerCase().startsWith("notification"));
      const hasNotificationsText =
        text === "notifications" ||
        (text && text.toLowerCase().trim() === "notifications");
      return (
        (href === "#" || !href) &&
        (hasNotificationsLabel || hasNotificationsText)
      );
    },
  },
  {
    key: "create",
    match: ({ href, ariaLabel, text }) =>
      (href === "#" || !href) &&
      (ariaLabel === "New post" || text === "create"),
  },
  {
    key: "moreFromMeta",
    match: ({ href, ariaLabel, text }) =>
      (href === "#" || !href) &&
      (ariaLabel === "Also from Meta" || text === "also from meta"),
  },
];

function getNavLinks() {
  const navContainer =
    document.querySelector('div[class*="x1xgvd2v"]') || document.body;
  return navContainer.querySelectorAll('a[role="link"]');
}

function hideTab(link) {
  const container =
    link.closest('span[class*="html-span"]') || link.parentElement;
  const target = container || link;
  target.style.display = "none";
  target.dataset.instafnHidden = "true";
}

function matchesDisabledRule(link) {
  const href = link.getAttribute("href");
  const ariaLabel =
    link.getAttribute("aria-label") ||
    link.querySelector("svg[aria-label]")?.getAttribute("aria-label");
  const text = link.textContent?.trim().toLowerCase();
  const descriptor = { href, ariaLabel, text, link };

  for (const { key, match } of TAB_RULES) {
    if (disabledTabs.has(key) && match(descriptor)) {
      return true;
    }
  }
  return false;
}

function processTabs() {
  if (!isEnabled) return;
  getNavLinks().forEach((link) => {
    if (link.dataset.instafnProcessed === "true") return;
    if (matchesDisabledRule(link)) {
      hideTab(link);
    }
    link.dataset.instafnProcessed = "true";
  });
}

function startObserver() {
  if (observer) return;

  observer = new MutationObserver(() => {
    processTabs();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function injectEarlyHideCSS(disabledTabsSet) {
  // Remove existing style if any
  if (injectedStyleElement) {
    injectedStyleElement.remove();
    injectedStyleElement = null;
  }

  if (disabledTabsSet.size === 0) return;

  // Generate CSS rules to hide tabs immediately based on disabled tabs
  const cssRules = [];

  if (disabledTabsSet.has("search")) {
    cssRules.push(`
      a[role="link"][href="#"]:has(svg[aria-label="Search"]),
      a[role="link"][href="/"]:has(svg[aria-label="Search"]),
      a[role="link"][aria-label="Search"],
      a[role="link"][href="#"]:has(svg[aria-label*="Search" i]),
      a[role="link"][href="/"]:has(svg[aria-label*="Search" i]) {
        display: none !important;
      }
    `);
  }

  if (disabledTabsSet.has("explore")) {
    cssRules.push(`
      a[role="link"][href="/explore/"],
      a[role="link"][href="/explore"],
      a[role="link"][aria-label="Explore"],
      a[role="link"][aria-label*="Explore" i],
      a[role="link"]:has(svg[aria-label="Explore"]),
      a[role="link"]:has(svg[aria-label*="Explore" i]) {
        display: none !important;
      }
    `);
  }

  if (disabledTabsSet.has("reels")) {
    cssRules.push(`
      a[role="link"][href="/reels/"],
      a[role="link"][href="/reels"],
      a[role="link"][aria-label="Reels"],
      a[role="link"][aria-label*="Reels" i],
      a[role="link"]:has(svg[aria-label="Reels"]),
      a[role="link"]:has(svg[aria-label*="Reels" i]) {
        display: none !important;
      }
    `);
  }

  if (disabledTabsSet.has("messages")) {
    cssRules.push(`
      a[role="link"][href*="/direct/inbox/"],
      a[role="link"][href*="/direct/"],
      a[role="link"][aria-label*="Direct messaging" i],
      a[role="link"][aria-label*="Direct" i],
      a[role="link"]:has(svg[aria-label*="Direct messaging" i]),
      a[role="link"]:has(svg[aria-label*="Direct" i]) {
        display: none !important;
      }
    `);
  }

  if (disabledTabsSet.has("notifications")) {
    cssRules.push(`
      /* Only match notifications tab - exclude messages tab which contains "Direct" */
      a[role="link"][href="#"]:has(svg[aria-label="Notifications"]):not([aria-label*="Direct"]):not([aria-label*="direct"]):not([aria-label*="DIRECT"]),
      a[role="link"][aria-label="Notifications"]:not([aria-label*="Direct"]):not([aria-label*="direct"]):not([aria-label*="DIRECT"]),
      a[role="link"]:has(svg[aria-label="Notifications"]):not([aria-label*="Direct"]):not([aria-label*="direct"]):not([aria-label*="DIRECT"]) {
        display: none !important;
      }
    `);
  }

  if (disabledTabsSet.has("create")) {
    cssRules.push(`
      a[role="link"][href="#"]:has(svg[aria-label="New post"]),
      a[role="link"][aria-label="New post"],
      a[role="link"][aria-label*="New post" i],
      a[role="link"][aria-label*="Create" i],
      a[role="link"]:has(svg[aria-label="New post"]),
      a[role="link"]:has(svg[aria-label*="New post" i]),
      a[role="link"]:has(svg[aria-label*="Create" i]) {
        display: none !important;
      }
    `);
  }

  if (disabledTabsSet.has("moreFromMeta")) {
    cssRules.push(`
      a[role="link"][href="#"]:has(svg[aria-label="Also from Meta"]),
      a[role="link"][aria-label="Also from Meta"],
      a[role="link"][aria-label*="Also from Meta" i],
      a[role="link"]:has(svg[aria-label*="Also from Meta" i]) {
        display: none !important;
      }
    `);
  }

  if (cssRules.length > 0) {
    // Remove existing style first
    const existing = document.getElementById("instafn-tab-disabler-early");
    if (existing) {
      existing.remove();
    }

    const style = document.createElement("style");
    style.id = "instafn-tab-disabler-early";
    style.textContent = cssRules.join("\n");

    // Inject immediately - try head first, then documentElement, then body
    const injectStyle = () => {
      const target = document.head || document.documentElement || document.body;
      if (target) {
        // Check if already exists to avoid duplicates
        if (!document.getElementById("instafn-tab-disabler-early")) {
          target.appendChild(style);
          injectedStyleElement = style;
        }
        return true;
      }
      return false;
    };

    if (!injectStyle()) {
      // If injection failed, try again when DOM is ready
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", injectStyle, {
          once: true,
        });
        // Also try immediately in case documentElement exists
        setTimeout(injectStyle, 0);
      } else {
        injectStyle();
      }
    }
  }
}

function initTabDisablerEarly(settings) {
  // Build disabled tabs set
  const disabledTabsSet = new Set();
  TAB_RULES.forEach(({ key }) => {
    if (settings[`disableTab${key[0].toUpperCase()}${key.slice(1)}`]) {
      disabledTabsSet.add(key);
    }
  });

  // Inject CSS immediately to prevent flash
  if (disabledTabsSet.size > 0) {
    injectEarlyHideCSS(disabledTabsSet);
  } else {
    // Remove CSS if no tabs are disabled
    if (injectedStyleElement) {
      injectedStyleElement.remove();
      injectedStyleElement = null;
    }
  }
}

function initTabDisabler(settings) {
  disabledTabs.clear();
  stopObserver();

  TAB_RULES.forEach(({ key }) => {
    if (settings[`disableTab${key[0].toUpperCase()}${key.slice(1)}`]) {
      disabledTabs.add(key);
    }
  });

  isEnabled = disabledTabs.size > 0;

  // Update early CSS injection
  if (isEnabled) {
    injectEarlyHideCSS(disabledTabs);
  } else {
    // Remove CSS if no tabs are disabled
    if (injectedStyleElement) {
      injectedStyleElement.remove();
      injectedStyleElement = null;
    }
  }

  if (!isEnabled) {
    document.querySelectorAll('[data-instafn-hidden="true"]').forEach((el) => {
      el.style.display = "";
      delete el.dataset.instafnHidden;
    });
    document
      .querySelectorAll('[data-instafn-processed="true"]')
      .forEach((el) => {
        delete el.dataset.instafnProcessed;
      });
    return;
  }

  document.querySelectorAll('[data-instafn-processed="true"]').forEach((el) => {
    delete el.dataset.instafnProcessed;
  });

  const runProcessing = () => {
    processTabs();
    startObserver();
  };

  if (document.body) {
    runProcessing();
    setTimeout(processTabs, 500);
  } else {
    const bodyObserver = new MutationObserver(() => {
      if (document.body) {
        runProcessing();
        bodyObserver.disconnect();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }
}


module.exports.initTabDisablerEarly = initTabDisablerEarly;
module.exports.initTabDisabler = initTabDisabler;
});


defineModule("features/changelog/index.js", function (module, exports, require) {
/**
 * Changelog ("What's New") feature.
 *
 * Shows a modal listing every release the user hasn't seen yet, the first time
 * they land on Instagram after the extension updates.
 *
 * Trigger model (the "semantic" part):
 *   - The installed version is the manifest version (chrome.runtime.getManifest).
 *   - We persist `lastSeenChangelogVersion` in chrome.storage.sync.
 *   - On load: if the installed version is newer than the last seen one, we show
 *     every CHANGELOG entry in the (lastSeen, current] range, then write the
 *     current version back so it won't show again.
 *   - Fresh installs are seeded silently by the background onInstalled handler
 *     (the welcome page already greets new users), so they don't get a changelog
 *     for a version they never ran.
 */

var { createModal } = require("ui/modal.js");
var { CHANGELOG } = require("features/changelog/changelog.js");

const STORAGE_KEY = "lastSeenChangelogVersion";

const TYPE_META = {
  new: { label: "New" },
  improved: { label: "Improved" },
  fixed: { label: "Fixed" },
  removed: { label: "Removed" },
};

// The order type groups are rendered in within each release.
const TYPE_ORDER = ["new", "improved", "fixed", "removed"];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Format a "YYYY-MM-DD" string as e.g. "June 24, 2026". Parsed by hand so it
 * doesn't shift across time zones. Returns the input unchanged if unparseable.
 */
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const [, year, month, day] = m;
  return `${MONTHS[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${year}`;
}

/**
 * Compare two semver-ish version strings ("1", "1.0", "1.2.3").
 * Returns >0 if a>b, <0 if a<b, 0 if equal. Missing parts count as 0.
 */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let stylesInjected = false;
function ensureChangelogStyles() {
  if (stylesInjected) return;
  const styleId = "instafn-changelog-styles";
  if (document.getElementById(styleId)) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    .instafn-changelog-body {
      padding: 8px 20px 20px 20px;
    }
    .instafn-changelog-release + .instafn-changelog-release {
      margin-top: 8px;
      padding-top: 20px;
      border-top: 1px solid rgba(var(--ig-primary-text), 0.1);
    }
    .instafn-changelog-version {
      display: block;
      margin: 12px 0 4px 0;
      font-size: var(--system-16-font-size);
      font-weight: var(--font-weight-system-semibold);
      color: rgb(var(--ig-primary-text));
      font-family: var(--font-family-system);
    }
    .instafn-changelog-title {
      margin: 0 0 4px 0;
      font-size: var(--system-14-font-size);
      line-height: 1.4;
      color: rgb(var(--ig-secondary-text));
      font-family: var(--font-family-system);
    }
    .instafn-changelog-group {
      margin-top: 16px;
    }
    .instafn-changelog-badge {
      display: inline-flex;
      align-items: center;
      font-size: var(--system-14-font-size);
      font-weight: var(--font-weight-system-semibold);
      font-family: var(--font-family-system);
      color: rgb(var(--ig-link));
    }
    .instafn-changelog-list {
      margin: 8px 0 0 0;
      padding-left: 22px;
      list-style: disc;
    }
    .instafn-changelog-list li {
      font-size: var(--system-14-font-size);
      color: rgb(var(--ig-primary-text));
      font-family: var(--font-family-system);
      line-height: 1.4;
      padding: 3px 0;
    }
    .instafn-changelog-list li::marker {
      color: rgb(var(--ig-secondary-text));
    }
    .instafn-changelog-feature {
      font-weight: var(--font-weight-system-semibold);
    }
    .instafn-changelog-footer {
      display: flex;
      justify-content: flex-end;
      padding: 16px 20px;
      border-top: 1px solid rgba(var(--ig-primary-text), 0.1);
    }
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

function renderReleases(releases) {
  ensureChangelogStyles();
  return releases
    .map((release) => {
      const all = release.changes || [];
      // Any types we don't have an explicit order for get appended at the end.
      const seen = new Set(TYPE_ORDER);
      const order = [
        ...TYPE_ORDER,
        ...all.map((c) => c.type).filter((t) => t && !seen.has(t) && !seen.add(t)),
      ];

      const groups = order
        .map((type) => {
          const items = all.filter((c) => c.type === type);
          if (!items.length) return "";
          const meta = TYPE_META[type] || { label: type || "Note" };
          const bullets = items
            .map((c) => `<li>${c.text}</li>`)
            .join("");
          return `
            <div class="instafn-changelog-group">
              <span class="instafn-changelog-badge">${meta.label}</span>
              <ul class="instafn-changelog-list">${bullets}</ul>
            </div>`;
        })
        .join("");

      return `
        <div class="instafn-changelog-release">
          <span class="instafn-changelog-version">Version ${release.version}</span>
          ${release.title ? `<p class="instafn-changelog-title">${release.title}</p>` : ""}
          ${groups}
        </div>`;
    })
    .join("");
}

/**
 * Build and display the changelog modal for the given releases.
 * Exported so it can be opened manually (e.g. from settings) too.
 *
 * The modal is deliberately "sticky": it can only be dismissed with the
 * "Got it" button or the X. Clicking the backdrop or pressing Escape does
 * nothing, so the user can't dismiss it by accident. `onDismiss` runs only on
 * an explicit dismiss — closing the tab does NOT count as seeing it.
 *
 * @param {Array} releases - Releases to render.
 * @param {Function} [onDismiss] - Called once when the user explicitly dismisses.
 */
async function showChangelogModal(releases, onDismiss) {
  if (!releases || !releases.length) return;
  // Newest release leads; surface its date in the header (in brackets).
  const headerDate = releases[0] && releases[0].date
    ? ` (${formatDate(releases[0].date)})`
    : "";
  const overlay = await createModal(`What’s new in Instafn${headerDate}`, {
    showTabs: false,
    closeOnBackdrop: false,
    closeOnEscape: false,
  });
  const content = overlay.querySelector(".instafn-content");

  let dismissed = false;
  const dismissModal = () => {
    if (dismissed) return;
    dismissed = true;
    overlay.remove();
    if (typeof onDismiss === "function") onDismiss();
  };

  const body = document.createElement("div");
  body.className = "instafn-changelog-body";
  body.innerHTML = renderReleases(releases);
  content.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "instafn-changelog-footer";
  const dismiss = document.createElement("button");
  dismiss.className = "instafn-primary-button";
  dismiss.textContent = "Got it";
  dismiss.addEventListener("click", dismissModal);
  footer.appendChild(dismiss);

  // The X in the header also counts as an explicit dismiss.
  const closeBtn = overlay.querySelector(".instafn-close");
  if (closeBtn) closeBtn.addEventListener("click", dismissModal);

  // Footer lives outside the scrollable content so the button is always visible.
  overlay.querySelector(".instafn-modal").appendChild(footer);
  return overlay;
}

/**
 * Entry point — call once on page load. Decides whether to show the modal and
 * records the current version as seen.
 */
function initChangelog() {
  let currentVersion;
  try {
    currentVersion = chrome.runtime.getManifest().version;
  } catch (err) {
    return; // not in an extension context
  }

  chrome.storage.sync.get({ [STORAGE_KEY]: null }, (result) => {
    if (chrome.runtime.lastError) return;
    const lastSeen = result[STORAGE_KEY];

    // No baseline yet (e.g. updated from a build before this feature existed, and
    // the background handler hasn't seeded it). Record current and stay silent so
    // we never dump the whole history on someone the first time.
    if (lastSeen == null) {
      chrome.storage.sync.set({ [STORAGE_KEY]: currentVersion });
      return;
    }

    if (compareVersions(currentVersion, lastSeen) <= 0) return; // already up to date

    // Show every release strictly newer than what they last saw.
    const unseen = CHANGELOG.filter(
      (r) => compareVersions(r.version, lastSeen) > 0
    );

    const markSeen = () =>
      chrome.storage.sync.set({ [STORAGE_KEY]: currentVersion });

    if (!unseen.length) {
      // No copy for this version — mark seen now so we don't re-check forever.
      markSeen();
      return;
    }

    // Only record the version as seen once the user explicitly dismisses the
    // modal. Closing the tab without dismissing leaves it to show again next time.
    showChangelogModal(unseen, markSeen).catch((err) =>
      console.error("Instafn: Error showing changelog:", err)
    );
  });
}


module.exports.showChangelogModal = showChangelogModal;
module.exports.initChangelog = initChangelog;
});


defineModule("features/changelog/changelog.js", function (module, exports, require) {
/**
 * Changelog data — the single source of truth for "What's New".
 *
 * How to ship an update:
 *   1. Bump "version" in src/manifest.json (semver, e.g. 1.1 -> 1.2).
 *   2. Add a new entry at the TOP of CHANGELOG below, with a matching version.
 *   3. That's it. The modal shows automatically to anyone updating from an
 *      older version (see ./index.js for the trigger logic).
 *
 * Entry shape:
 *   {
 *     version: "1.1",          // must match manifest.json
 *     date: "2026-06-24",      // YYYY-MM-DD, shown (in brackets) in the modal header
 *     title: "Optional headline shown under the version",
 *     changes: [
 *       { type: "new",      text: "..." },  // green  — brand new feature
 *       { type: "improved", text: "..." },  // blue   — changed / better
 *       { type: "fixed",    text: "..." },  // orange — bug fix
 *       { type: "removed",  text: "..." },  // red    — feature taken out
 *     ],
 *   }
 *
 * Changes are grouped by type in the modal: each type gets its label as a
 * header with the entries rendered as bullet points underneath. Order within a
 * type follows the order you list them here.
 *
 * Keep newest first. Whatever you write here is what users read.
 */
const CHANGELOG = [
  {
    version: "1.1",
    date: "2026-06-24",
    title:
      "Hey everyone, thank you for using my extension. Apologies for the long wait, I have been busy with university and work, but hopefully the new features make up for it!",
    changes: [
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Native DM Themes:</span> You can see your themes set in chat on Instagram web now! Changes the background and colour scheme of chats, just like on mobile.',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Media Downloader:</span> long awaited feature! Hope you enjoy. Download buttons on posts, reels, stories, profile pictures, voice notes, and DM media.',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">More hiding UI:</span> hide suggested accounts, footer, right sidebar, and more!',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Hold Video for 2x Speed:</span> hold down on a video to consume brainrot at 2x the speed!',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Drag Carousel Dots to Scrub:</span> you can now drag across a post’s dots to scrub through its carousel images, just like on mobile.',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Profile Grid Columns:</span> choose how many columns you want to see on a profile’s grid.',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Show Date on Post Hover:</span> hover over a post on a profile grid to see its date alongside the like and comment counts.',
      },
      {
        type: "new",
        text: '<span class="instafn-changelog-feature">Backup:</span> a new section to export and import all your settings.',
      },
      {
        type: "improved",
        text: '<span class="instafn-changelog-feature">Date displays</span> now support fully custom formats, plus several new built-in date styles.',
      },
      {
        type: "improved",
        text: '<span class="instafn-changelog-feature">Message Logger:</span> the button now shows an unread dot, and the log modal UI has been polished.',
      },
      {
        type: "fixed",
        text: '<span class="instafn-changelog-feature">Double-Tap to Like Messages</span>, <span class="instafn-changelog-feature">Quick Reply</span>, and <span class="instafn-changelog-feature">Quick Edit</span> now work again.',
      },
      {
        type: "fixed",
        text: '<span class="instafn-changelog-feature">Confirm Story Replies:</span> no longer triggers on the share sheet’s “Send” button or the DM message bar.',
      },
      {
        type: "fixed",
        text: '<span class="instafn-changelog-feature">Message Logger:</span> behaviour has been updated and is now working again.',
      },
      {
        type: "fixed",
        text: '<span class="instafn-changelog-feature">Message Logger:</span> group chat names now show up.',
      },
      {
        type: "fixed",
        text: '<span class="instafn-changelog-feature">Show Follow Status Indicator:</span> now shows when you click on a profile’s reels, tagged, or reposted section.',
      },
      {
        type: "removed",
        text: '<span class="instafn-changelog-feature">Profile Comments</span> has been removed (no one cares).',
      },
    ],
  },
];


module.exports.CHANGELOG = CHANGELOG;
});


defineModule("features/video-scrubber/videoScrubber.js", function (module, exports, require) {
var { injectStylesheet } = require("utils/styleLoader.js");

let observer = null;
let isEnabled = false;

function isReelContext(element) {
  if (!element) return false;

  // Check URL path for reels
  const pathname = window.location.pathname;
  if (pathname.includes("/reels/") || pathname.includes("/reel/")) {
    return true;
  }

  // Check for reel-specific DOM structures
  if (
    element.closest('[data-testid="reel"]') ||
    element.closest('a[href*="/reels/"]') ||
    element.closest('a[href*="/reels/audio/"]')
  ) {
    return true;
  }

  // Check if parent container has reel-like structure
  let container = element.parentElement;
  let depth = 0;
  while (container && depth < 10) {
    const containerClasses = container.className || "";
    // Check for reel-specific class patterns
    if (
      containerClasses.includes("xyamay9") ||
      containerClasses.includes("x1l90r2v") ||
      container.querySelector('a[href*="/reels/"]') ||
      container.querySelector('a[href*="/reels/audio/"]')
    ) {
      return true;
    }
    container = container.parentElement;
    depth++;
  }

  return false;
}

function isCallContext() {
  // Check if we're on a call page
  return window.location.pathname.includes("/call/");
}

function isDMChatVideo(element) {
  if (!element) return false;

  // Check if we're on a DM page
  const pathname = window.location.pathname;
  if (pathname.includes("/direct/") || pathname.includes("/direct")) {
    return true;
  }

  // Check if video is within a DM chat container
  // DM chats have specific aria-labels and structures
  let container = element.parentElement;
  let depth = 0;
  while (container && depth < 15) {
    // Check for DM-specific indicators
    const ariaLabel = container.getAttribute("aria-label") || "";
    if (
      ariaLabel.includes("Conversation") ||
      ariaLabel.includes("conversation") ||
      ariaLabel.includes("Message") ||
      ariaLabel.includes("message")
    ) {
      // Check if it's actually a DM chat (not just any conversation)
      // DM chat containers often have specific class patterns or data attributes
      const containerClasses = container.className || "";
      if (
        container.closest('div[role="dialog"]') ||
        container.closest('div[aria-label*="Conversation"]') ||
        container.closest('div[aria-label*="conversation"]')
      ) {
        // Additional check: look for DM-specific URL patterns in links
        const hasDMLink = container.querySelector('a[href*="/direct/"]');
        if (hasDMLink) {
          return true;
        }
      }
    }

    // Check for direct message thread indicators
    if (container.querySelector && container.querySelector('a[href*="/direct/t/"]')) {
      return true;
    }

    container = container.parentElement;
    depth++;
  }

  return false;
}

function isExploreGridVideo(element) {
  if (!element) return false;

  // Check if we're on the explore page
  const pathname = window.location.pathname;
  if (!pathname.includes("/explore/") && pathname !== "/explore/") {
    return false;
  }

  // Check if video is in a modal/dialog/popup (these should get scrubbers)
  // Modals typically have specific attributes or are in specific containers
  if (
    element.closest('[role="dialog"]') ||
    element.closest('[role="presentation"]') ||
    element.closest('div[style*="position: fixed"]') ||
    element.closest('div[style*="z-index"]') ||
    element.closest('div[aria-modal="true"]')
  ) {
    return false; // In a modal, so allow scrubber
  }

  // Check if video is in a grid container (explore grid)
  // Explore grid has specific class patterns like x121lspk (grid template columns)
  let container = element.parentElement;
  let depth = 0;
  while (container && depth < 15) {
    const containerClasses = container.className || "";
    // Check for explore grid patterns
    if (
      containerClasses.includes("x121lspk") || // grid template columns
      containerClasses.includes("xrvj5dj") || // grid related
      containerClasses.includes("xqketvx") // grid related
    ) {
      // Make sure it's not in a modal
      const hasModalParent =
        container.closest('[role="dialog"]') ||
        container.closest('[role="presentation"]') ||
        container.closest('div[aria-modal="true"]');
      if (!hasModalParent) {
        return true; // In explore grid, skip scrubber
      }
    }
    container = container.parentElement;
    depth++;
  }

  return false;
}

function ensureRelativePositioning(container) {
  const computed = window.getComputedStyle(container);
  if (computed.position === "static") {
    container.style.position = "relative";
  }
  // Create stacking context so z-index within works as intended
  if (computed.isolation !== "isolate") {
    container.style.isolation = "isolate";
  }
}

function disableBlockingOverlays(rootContainer) {
  // Common IG overlay masks that can intercept clicks
  const masks = rootContainer.querySelectorAll(
    [
      "div.x1ey2m1c.x9f619.xtijo5x.x1o0tod.x10l6tqk.x13vifvy.x1ypdohk",
      'div.x5yr21d.x10l6tqk.x13vifvy.xh8yej3[data-visualcompletion="ignore"]',
      'div[role="presentation"] .x1ey2m1c',
      'div[aria-hidden="true"], div[aria-hidden="true"] *',
      '[data-visualcompletion="ignore-late-mutation"]',
    ].join(",")
  );
  masks.forEach((el) => {
    el.style.pointerEvents = "none";
  });
}

function makeButtonClickable(button, rootContainer) {
  if (!button) return;

  button.style.pointerEvents = "auto";
  button.style.setProperty("pointer-events", "auto", "important");
  let parent = button.parentElement;
  let depth = 0;
  while (parent && parent !== rootContainer && depth < 10) {
    if (parent.style.pointerEvents === "none") {
      parent.style.pointerEvents = "auto";
      parent.style.setProperty("pointer-events", "auto", "important");
    }
    parent = parent.parentElement;
    depth++;
  }
}

function rearrangeVideoAfterInstanceKey(video) {
  const rootContainer = video.parentElement;
  if (!rootContainer) return;
  const instanceKeyContainer = rootContainer.querySelector(
    "[data-instancekey]"
  );
  if (!instanceKeyContainer) return;

  if (instanceKeyContainer.nextSibling !== video) {
    instanceKeyContainer.parentNode.insertBefore(
      video,
      instanceKeyContainer.nextSibling
    );
  }

  // After rearranging, ensure overlays/buttons are correctly layered and unblocked
  disableBlockingOverlays(rootContainer);
}

function setupFeedVideoScrubber(video, rootContainer, scrubberContainer) {
  // Get references to scrubber elements
  const scrubberTrack = scrubberContainer.querySelector(
    ".instafn-reel-scrubber-track"
  );
  const scrubberProgress = scrubberContainer.querySelector(
    ".instafn-reel-scrubber-progress"
  );
  const scrubberHandle = scrubberContainer.querySelector(
    ".instafn-reel-scrubber-handle"
  );
  const timePill = scrubberContainer.querySelector(".instafn-reel-time-pill");

  if (!scrubberTrack || !scrubberProgress || !scrubberHandle || !timePill) {
    return; // Elements not found
  }

  // Handle scrubbing state
  let isScrubbing = false;
  let wasPlaying = false;

  const formatTime = (seconds) => {
    if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatTimeRange = (current, total) => {
    return `${formatTime(current)} / ${formatTime(total)}`;
  };

  // Update progress on timeupdate (only when not scrubbing)
  const updateProgress = () => {
    if (
      !isScrubbing &&
      video.duration &&
      isFinite(video.duration) &&
      video.duration > 0
    ) {
      const progress = Math.max(
        0,
        Math.min(100, (video.currentTime / video.duration) * 100)
      );
      // Update progress bar - use setProperty to ensure it works
      scrubberProgress.style.setProperty("width", `${progress}%`, "important");
      // Update handle position
      scrubberHandle.style.left = `${progress}%`;
    }
  };

  // Set up video event listeners
  const setupVideoListeners = () => {
    video.addEventListener("timeupdate", updateProgress);
    video.addEventListener("loadedmetadata", () => {
      updateProgress();
    });
    video.addEventListener("loadeddata", () => {
      updateProgress();
    });
    video.addEventListener("canplay", () => {
      updateProgress();
    });
    video.addEventListener("progress", () => {
      updateProgress();
    });

    // Initial update if video is already ready
    if (video.readyState >= 2) {
      updateProgress();
    }
  };

  setupVideoListeners();

  // Also use requestAnimationFrame for smooth updates
  let rafId = null;
  const rafUpdate = () => {
    if (!isScrubbing && video.readyState >= 2) {
      updateProgress();
    }
    rafId = requestAnimationFrame(rafUpdate);
  };
  rafId = requestAnimationFrame(rafUpdate);

  // Get mouse/touch position relative to track
  const getPositionFromEvent = (e) => {
    const rect = scrubberTrack.getBoundingClientRect();
    const clientX =
      e.clientX !== undefined ? e.clientX : e.touches?.[0]?.clientX;
    if (clientX === undefined) return null;
    const x = clientX - rect.left;
    return Math.max(0, Math.min(rect.width, x));
  };

  const updateTimePill = (percent) => {
    if (!video.duration || !isFinite(video.duration)) return;
    const time = (percent / 100) * video.duration;
    timePill.textContent = formatTimeRange(time, video.duration);
    // Time pill stays centered - don't set left position
    timePill.classList.add("visible");
  };

  const startScrubbing = (e) => {
    e.preventDefault();
    e.stopPropagation();
    isScrubbing = true;
    wasPlaying = !video.paused;
    video.pause();
    scrubberContainer.style.opacity = "1";
    // Remove transition delay when scrubbing
    scrubberHandle.classList.add("scrubbing");

    const pos = getPositionFromEvent(e);
    if (pos !== null) {
      const rect = scrubberTrack.getBoundingClientRect();
      const percent = (pos / rect.width) * 100;
      updateTimePill(percent);
      scrub(e);
    }
  };

  const scrub = (e) => {
    if (!isScrubbing) return;
    const pos = getPositionFromEvent(e);
    if (pos === null) return;

    const rect = scrubberTrack.getBoundingClientRect();
    const percent = Math.max(0, Math.min(100, (pos / rect.width) * 100));

    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      const time = (percent / 100) * video.duration;
      video.currentTime = time;
      // Update instantly without transition
      scrubberProgress.style.transition = "none";
      scrubberProgress.style.setProperty("width", `${percent}%`, "important");
      scrubberHandle.style.left = `${percent}%`;
      scrubberHandle.style.transition = "opacity 0.2s, left 0s !important";
      updateTimePill(percent);
    }
  };

  const stopScrubbing = (e) => {
    if (!isScrubbing) return;
    isScrubbing = false;
    timePill.classList.remove("visible");
    // Restore transition for smooth playback
    scrubberHandle.classList.remove("scrubbing");
    scrubberHandle.style.transition = "";
    scrubberProgress.style.transition = "";

    // Don't auto-hide if hovering
    if (!rootContainer.matches(":hover")) {
      scrubberContainer.style.opacity = "";
    }

    // Resume playing if it was playing before
    if (wasPlaying) {
      video.play().catch(() => {
        // Ignore play errors
      });
    }
  };

  // Mouse events
  scrubberTrack.addEventListener("mousedown", startScrubbing);

  const handleMouseMove = (e) => {
    if (isScrubbing) {
      scrub(e);
    }
  };

  const handleMouseUp = (e) => {
    stopScrubbing(e);
  };

  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);

  // Touch events
  scrubberTrack.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      startScrubbing(e);
    },
    { passive: false }
  );

  const handleTouchMove = (e) => {
    if (isScrubbing) {
      e.preventDefault();
      scrub(e);
    }
  };

  const handleTouchEnd = (e) => {
    if (isScrubbing) {
      stopScrubbing(e);
    }
  };

  document.addEventListener("touchmove", handleTouchMove, { passive: false });
  document.addEventListener("touchend", handleTouchEnd);

  // Also allow clicking on track to jump
  scrubberTrack.addEventListener("click", (e) => {
    if (!isScrubbing) {
      const pos = getPositionFromEvent(e);
      if (pos !== null && video.duration && isFinite(video.duration)) {
        const rect = scrubberTrack.getBoundingClientRect();
        const percent = (pos / rect.width) * 100;
        const time = (percent / 100) * video.duration;
        video.currentTime = time;
      }
    }
  });
}

function processReelVideo(video) {
  if (!video || video.dataset.instafnReelScrubber === "true") return;

  // Skip videos on call pages
  if (isCallContext()) {
    return;
  }

  // Skip videos in DM chat
  if (isDMChatVideo(video)) {
    return;
  }

  // Skip videos in explore grid - only add scrubbers when clicked and in popup
  if (isExploreGridVideo(video)) {
    return;
  }

  // Mark as processed
  video.dataset.instafnReelScrubber = "true";

  // Remove native controls
  video.removeAttribute("controls");

  // Ensure CSS is injected
  ensureReelScrubberCSS();

  const rootContainer = video.parentElement;
  if (!rootContainer) return;

  // Ensure container has relative positioning
  ensureRelativePositioning(rootContainer);
  rootContainer.classList.add("instafn-reel-container");

  // Create scrubber container
  let scrubberContainer = rootContainer.querySelector(".instafn-reel-scrubber");
  if (!scrubberContainer) {
    scrubberContainer = document.createElement("div");
    scrubberContainer.className = "instafn-reel-scrubber";

    // Create scrubber track
    const scrubberTrack = document.createElement("div");
    scrubberTrack.className = "instafn-reel-scrubber-track";

    // Create scrubber progress
    const scrubberProgress = document.createElement("div");
    scrubberProgress.className = "instafn-reel-scrubber-progress";

    // Create scrubber handle
    const scrubberHandle = document.createElement("div");
    scrubberHandle.className = "instafn-reel-scrubber-handle";

    // Create time pill
    const timePill = document.createElement("div");
    timePill.className = "instafn-reel-time-pill";
    timePill.textContent = "0:00 / 0:00";

    scrubberTrack.appendChild(scrubberProgress);
    scrubberTrack.appendChild(scrubberHandle);
    scrubberContainer.appendChild(scrubberTrack);
    scrubberContainer.appendChild(timePill);
    rootContainer.appendChild(scrubberContainer);
  }

  // Get references to scrubber elements
  const scrubberTrack = scrubberContainer.querySelector(
    ".instafn-reel-scrubber-track"
  );
  const scrubberProgress = scrubberContainer.querySelector(
    ".instafn-reel-scrubber-progress"
  );
  const scrubberHandle = scrubberContainer.querySelector(
    ".instafn-reel-scrubber-handle"
  );
  const timePill = scrubberContainer.querySelector(".instafn-reel-time-pill");

  if (!scrubberTrack || !scrubberProgress || !scrubberHandle || !timePill) {
    return; // Elements not found
  }

  // Handle scrubbing state
  let isScrubbing = false;
  let wasPlaying = false;

  const formatTime = (seconds) => {
    if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatTimeRange = (current, total) => {
    return `${formatTime(current)} / ${formatTime(total)}`;
  };

  // Update progress on timeupdate (only when not scrubbing)
  const updateProgress = () => {
    if (
      !isScrubbing &&
      video.duration &&
      isFinite(video.duration) &&
      video.duration > 0
    ) {
      const progress = Math.max(
        0,
        Math.min(100, (video.currentTime / video.duration) * 100)
      );
      // Update progress bar
      scrubberProgress.style.width = `${progress}%`;
      // Update handle position
      scrubberHandle.style.left = `${progress}%`;
    }
  };

  // Set up video event listeners
  const setupVideoListeners = () => {
    video.addEventListener("timeupdate", updateProgress);
    video.addEventListener("loadedmetadata", () => {
      updateProgress();
    });
    video.addEventListener("loadeddata", () => {
      updateProgress();
    });
    video.addEventListener("canplay", () => {
      updateProgress();
    });
    video.addEventListener("progress", () => {
      updateProgress();
    });

    // Initial update if video is already ready
    if (video.readyState >= 2) {
      updateProgress();
    }
  };

  setupVideoListeners();

  // Also use requestAnimationFrame for smooth updates
  let rafId = null;
  const rafUpdate = () => {
    if (!isScrubbing && video.readyState >= 2) {
      updateProgress();
    }
    rafId = requestAnimationFrame(rafUpdate);
  };
  rafId = requestAnimationFrame(rafUpdate);

  // Clean up on video removal
  const observer = new MutationObserver(() => {
    if (!document.contains(video)) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Get mouse/touch position relative to track
  const getPositionFromEvent = (e) => {
    const rect = scrubberTrack.getBoundingClientRect();
    const clientX =
      e.clientX !== undefined ? e.clientX : e.touches?.[0]?.clientX;
    if (clientX === undefined) return null;
    const x = clientX - rect.left;
    return Math.max(0, Math.min(rect.width, x));
  };

  const updateTimePill = (percent) => {
    if (!video.duration || !isFinite(video.duration)) return;
    const time = (percent / 100) * video.duration;
    timePill.textContent = formatTimeRange(time, video.duration);
    // Time pill stays centered - don't set left position
    timePill.classList.add("visible");
  };

  const startScrubbing = (e) => {
    e.preventDefault();
    e.stopPropagation();
    isScrubbing = true;
    wasPlaying = !video.paused;
    video.pause();
    scrubberContainer.style.opacity = "1";
    // Remove transition delay when scrubbing
    scrubberHandle.classList.add("scrubbing");

    const pos = getPositionFromEvent(e);
    if (pos !== null) {
      const rect = scrubberTrack.getBoundingClientRect();
      const percent = (pos / rect.width) * 100;
      updateTimePill(percent);
      scrub(e);
    }
  };

  const scrub = (e) => {
    if (!isScrubbing) return;
    const pos = getPositionFromEvent(e);
    if (pos === null) return;

    const rect = scrubberTrack.getBoundingClientRect();
    const percent = Math.max(0, Math.min(100, (pos / rect.width) * 100));

    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      const time = (percent / 100) * video.duration;
      video.currentTime = time;
      // Update instantly without transition
      scrubberProgress.style.transition = "none";
      scrubberProgress.style.width = `${percent}%`;
      scrubberHandle.style.left = `${percent}%`;
      scrubberHandle.style.transition = "opacity 0.2s, left 0s !important";
      updateTimePill(percent);
    }
  };

  const stopScrubbing = (e) => {
    if (!isScrubbing) return;
    isScrubbing = false;
    timePill.classList.remove("visible");
    // Restore transition for smooth playback
    scrubberHandle.classList.remove("scrubbing");
    scrubberHandle.style.transition = "";
    scrubberProgress.style.transition = "";

    // Don't auto-hide if hovering
    if (!rootContainer.matches(":hover")) {
      scrubberContainer.style.opacity = "";
    }

    // Resume playing if it was playing before
    if (wasPlaying) {
      video.play().catch(() => {
        // Ignore play errors
      });
    }
  };

  // Mouse events
  scrubberTrack.addEventListener("mousedown", startScrubbing);

  const handleMouseMove = (e) => {
    if (isScrubbing) {
      scrub(e);
    }
  };

  const handleMouseUp = (e) => {
    stopScrubbing(e);
  };

  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);

  // Touch events
  scrubberTrack.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      startScrubbing(e);
    },
    { passive: false }
  );

  const handleTouchMove = (e) => {
    if (isScrubbing) {
      e.preventDefault();
      scrub(e);
    }
  };

  const handleTouchEnd = (e) => {
    if (isScrubbing) {
      stopScrubbing(e);
    }
  };

  document.addEventListener("touchmove", handleTouchMove, { passive: false });
  document.addEventListener("touchend", handleTouchEnd);

  // Also allow clicking on track to jump
  scrubberTrack.addEventListener("click", (e) => {
    if (!isScrubbing) {
      const pos = getPositionFromEvent(e);
      if (pos !== null && video.duration && isFinite(video.duration)) {
        const rect = scrubberTrack.getBoundingClientRect();
        const percent = (pos / rect.width) * 100;
        const time = (percent / 100) * video.duration;
        video.currentTime = time;
      }
    }
  });
}

function ensureReelScrubberCSS() {
  injectStylesheet(
    "content/features/video-scrubber/videoScrubber.css",
    "instafn-reel-scrubber"
  );
}

function processFeedVideo(video) {
  if (!isEnabled) return; // Don't process if disabled
  if (!video) return;

  // Skip videos on call pages
  if (isCallContext()) {
    return;
  }

  // Skip videos in DM chat
  if (isDMChatVideo(video)) {
    return;
  }

  // Skip videos in explore grid - only add scrubbers when clicked and in popup
  if (isExploreGridVideo(video)) {
    return;
  }

  // Check if this is a reel - if so, add custom scrubber
  if (isReelContext(video)) {
    processReelVideo(video);
    return;
  }

  if (video.dataset.instafnFeedControls === "true") return;

  // Mark processed
  video.dataset.instafnFeedControls = "true";

  // Remove native controls - we'll use custom scrubber
  video.removeAttribute("controls");

  // Ensure CSS is present once
  ensureReelScrubberCSS(); // Reuse the same scrubber CSS

  // Ensure video can receive clicks for play/pause
  video.style.pointerEvents = "auto";
  video.style.cursor = "pointer";
  video.style.zIndex = "1";

  const rootContainer = video.parentElement;
  if (rootContainer) {
    // Ensure the root container has relative positioning for absolute children
    ensureRelativePositioning(rootContainer);

    rootContainer.classList.add("instafn-feed-controls");
    rootContainer.classList.add("instafn-reel-container"); // Reuse reel container class for scrubber

    // Create scrubber for feed videos (same as reels)
    let scrubberContainer = rootContainer.querySelector(
      ".instafn-reel-scrubber"
    );
    if (!scrubberContainer) {
      scrubberContainer = document.createElement("div");
      scrubberContainer.className = "instafn-reel-scrubber";

      // Create scrubber track
      const scrubberTrack = document.createElement("div");
      scrubberTrack.className = "instafn-reel-scrubber-track";

      // Create scrubber progress
      const scrubberProgress = document.createElement("div");
      scrubberProgress.className = "instafn-reel-scrubber-progress";

      // Create scrubber handle
      const scrubberHandle = document.createElement("div");
      scrubberHandle.className = "instafn-reel-scrubber-handle";

      // Create time pill
      const timePill = document.createElement("div");
      timePill.className = "instafn-reel-time-pill";
      timePill.textContent = "0:00 / 0:00";

      scrubberTrack.appendChild(scrubberProgress);
      scrubberTrack.appendChild(scrubberHandle);
      scrubberContainer.appendChild(scrubberTrack);
      scrubberContainer.appendChild(timePill);
      rootContainer.appendChild(scrubberContainer);
    }

    // Set up scrubber functionality (same as reels)
    setupFeedVideoScrubber(video, rootContainer, scrubberContainer);

    // Add click-to-pause functionality directly on video
    const handleVideoClick = (e) => {
      // Don't pause if clicking through to scrubber or buttons
      const path = e.composedPath ? e.composedPath() : [];
      const hasScrubber = path.some(
        (el) =>
          el && el.classList && el.classList.contains("instafn-reel-scrubber")
      );
      const hasButton = path.some(
        (el) =>
          el &&
          (el.tagName === "BUTTON" ||
            (el.closest &&
              el.closest(
                'button[aria-label="Toggle audio"], button[aria-label="Tags"]'
              )))
      );

      if (hasScrubber || hasButton) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    };

    // Add both click and mousedown handlers for reliability
    video.addEventListener("click", handleVideoClick, true);
    video.addEventListener(
      "mousedown",
      (e) => {
        // Only handle if it's a simple click (not drag)
        const startY = e.clientY;
        const startX = e.clientX;
        const handleMouseUp = (upE) => {
          const deltaY = Math.abs(upE.clientY - startY);
          const deltaX = Math.abs(upE.clientX - startX);
          // If it's a small movement (click, not drag), toggle play/pause
          if (deltaY < 5 && deltaX < 5) {
            handleVideoClick(e);
          }
          document.removeEventListener("mouseup", handleMouseUp);
        };
        document.addEventListener("mouseup", handleMouseUp);
      },
      true
    );

    // Also handle clicks on the container area (above scrubber)
    rootContainer.addEventListener(
      "click",
      (e) => {
        // Skip if clicking on interactive elements
        if (
          e.target.closest(".instafn-reel-scrubber") ||
          e.target.closest('button[aria-label="Toggle audio"]') ||
          e.target.closest('button[aria-label="Tags"]') ||
          e.target.closest("a") ||
          e.target.closest("button") ||
          e.target.tagName === "BUTTON" ||
          e.target.tagName === "A" ||
          e.target === video // Video click is handled above
        ) {
          return;
        }

        // If clicking on container area, check if it's above the scrubber
        const scrubberRect = scrubberContainer.getBoundingClientRect();
        const clickY = e.clientY;

        // Only handle if click is above the scrubber area
        if (clickY < scrubberRect.top - 10) {
          e.preventDefault();
          e.stopPropagation();
          if (video.paused) {
            video.play().catch(() => {});
          } else {
            video.pause();
          }
        }
      },
      true
    );

    // Ensure mute and tags buttons are clickable
    const muteButton = rootContainer.querySelector(
      'button[aria-label="Toggle audio"]'
    );
    const tagsButton =
      rootContainer.querySelector('button[aria-label="Tags"]') ||
      rootContainer.querySelector('svg[aria-label="Tags"]')?.closest("button");

    makeButtonClickable(muteButton, rootContainer);
    makeButtonClickable(tagsButton, rootContainer);

    // Disable blocking overlays after setting up both buttons
    disableBlockingOverlays(rootContainer);
  }

  // Re-arrange structure to match desired order
  rearrangeVideoAfterInstanceKey(video);

  // Ensure overlays don't block buttons after rearrangement
  if (rootContainer) {
    disableBlockingOverlays(rootContainer);

    // Re-enable pointer events on buttons after disabling overlays
    const muteButton = rootContainer.querySelector(
      'button[aria-label="Toggle audio"]'
    );
    const tagsButton =
      rootContainer.querySelector('button[aria-label="Tags"]') ||
      rootContainer.querySelector('svg[aria-label="Tags"]')?.closest("button");

    makeButtonClickable(muteButton, rootContainer);
    makeButtonClickable(tagsButton, rootContainer);
  }
}

function scanExistingVideos() {
  const videos = document.querySelectorAll("video");
  videos.forEach((video) => processFeedVideo(video));
}

function disableVideoScrubber() {
  // Stop observer
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  // Remove controls from all videos that were processed
  const processedVideos = document.querySelectorAll(
    'video[data-instafn-feed-controls="true"], video[data-instafn-reel-scrubber="true"]'
  );
  processedVideos.forEach((video) => {
    video.removeAttribute("controls");
    video.removeAttribute("data-instafn-feed-controls");
    video.removeAttribute("data-instafn-reel-scrubber");
    const rootContainer = video.parentElement;
    if (rootContainer) {
      rootContainer.classList.remove("instafn-feed-controls");
      rootContainer.classList.remove("instafn-reel-container");
      // Remove scrubber if present
      const scrubber = rootContainer.querySelector(".instafn-reel-scrubber");
      if (scrubber) scrubber.remove();
    }
  });
}

function initVideoScrubber(enabled = false) {
  isEnabled = enabled;

  if (!isEnabled) {
    // Disable the feature
    disableVideoScrubber();
    return;
  }

  // Initial scan
  scanExistingVideos();

  // Observe dynamic content
  if (!observer) {
    observer = new MutationObserver((mutations) => {
      if (!isEnabled) return; // Don't process if disabled

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          if (node.tagName === "VIDEO") {
            processFeedVideo(node);
          } else if (node.querySelectorAll) {
            const videos = node.querySelectorAll("video");
            videos.forEach((v) => processFeedVideo(v));
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function updateVideoScrubber() {
  // For compatibility; re-run scan when called
  scanExistingVideos();
}

function isVideoScrubberActive() {
  return isEnabled;
}


module.exports.initVideoScrubber = initVideoScrubber;
module.exports.updateVideoScrubber = updateVideoScrubber;
module.exports.isVideoScrubberActive = isVideoScrubberActive;
});


defineModule("features/hide-suggested/index.js", function (module, exports, require) {
// Declutter assorted Instagram UI surfaces.
//
// This one feature handles every "hide a piece of IG chrome" toggle, because
// they share anchors and timing and only one observer should walk the (busy)
// DOM:
//   - hideHome    : the "Suggested for you" account list in the feed sidebar
//   - hideProfile : the "Suggested for you" carousel shown on profile pages
//   - hideFooter  : the About/Help/.../© Instagram footer text on the home feed
//   - hideSidebar : the entire right column (account switcher + suggestions +
//                   footer)
//   - hideStories : the stories tray strip across the top of the feed
//   - hideNotes   : the notes tray strip atop the Direct Messages inbox
//
// Both "Suggested for you" surfaces share the same heading text. We find every
// heading, walk up to the smallest ancestor that wraps the suggestion list (the
// lowest ancestor holding >= 2 "Follow" controls — a single card has one, and
// on the home feed each card also carries a "Suggested for you" subtitle, so
// matching the list is what stops us hiding individual cards), then climb past
// single-child wrappers so the module's outer padding collapses too.
//
// Hiding the home suggestion list leaves the account switcher flush against the
// footer, so when we hide it (and the footer is still shown) we add top spacing
// to the footer to keep the column breathing.
//
// To avoid any flash or layout shift, this runs at document_start: the
// MutationObserver is attached to <html> immediately (so it sees the modules the
// instant IG inserts them) and scans are coalesced into a requestAnimationFrame
// callback. Both MutationObserver and rAF callbacks fire before the browser
// paints, so a matched element is hidden before it's ever drawn.

let observer = null;
let scanScheduled = false;
let hideHome = false;
let hideProfile = false;
let hideFooter = false;
let hideSidebar = false;
let hideStories = false;
let hideNotes = false;

const HIDDEN_ATTR = "data-instafn-suggested-hidden";
const KIND_ATTR = "data-instafn-suggested-kind";
const SPACER_ATTR = "data-instafn-sidebar-spacer";
const STORIES_SPACER_ATTR = "data-instafn-stories-spacer";
const NOTES_SPACER_ATTR = "data-instafn-notes-spacer";

// Gap restored between the account switcher and footer when the home suggestion
// list is hidden, matching IG's usual sidebar rhythm.
const FOOTER_GAP = "24px";
// Top breathing room added above the feed when the stories tray is hidden, so
// the first post doesn't sit flush against the top.
const STORIES_GAP = "24px";
// Extra top margin on the DM "Messages" header when the notes tray above it is
// hidden, so the header isn't tight under the inbox title bar.
const NOTES_GAP = "16px";

// How many "Follow" buttons `el` wraps. A genuine suggestions module holds a
// list (>= 2); a single suggestion card holds exactly one.
function followButtonCount(el) {
  return Array.from(el.querySelectorAll('[role="button"], button')).filter(
    (b) => b.textContent.trim() === "Follow"
  ).length;
}

// From a heading element, find the module to hide: the lowest ancestor that
// wraps the suggestion list (>= 2 Follow buttons), then climb past single-child
// wrappers so the module's outer padding collapses too.
function resolveModule(heading) {
  let module = heading.parentElement;
  while (module && module !== document.body && followButtonCount(module) < 2) {
    module = module.parentElement;
  }
  if (!module || module === document.body) return null;

  while (
    module.parentElement &&
    module.parentElement !== document.body &&
    module.parentElement.children.length === 1
  ) {
    module = module.parentElement;
  }
  return module;
}

// "home" = feed sidebar suggestions (See all → /explore/people/),
// "profile" = the suggested-accounts carousel on a profile page.
function classifyModule(module) {
  return module.querySelector('a[href="/explore/people/"]')
    ? "home"
    : "profile";
}

function hideElement(el, kind) {
  if (el.getAttribute(HIDDEN_ATTR) === "true") return;
  el.setAttribute(HIDDEN_ATTR, "true");
  if (kind) el.setAttribute(KIND_ATTR, kind);
  el.style.setProperty("display", "none", "important");
}

function showElement(el) {
  el.removeAttribute(HIDDEN_ATTR);
  el.removeAttribute(KIND_ATTR);
  el.style.removeProperty("display");
}

// The home feed footer ("About · Help · …" + the © Instagram line). Its wrapper
// holds only the footer, so hiding the wrapper removes its spacing too.
function getFooter() {
  const footer = document.querySelector("._ab8b");
  if (!footer) return null;
  const wrapper = footer.parentElement;
  return wrapper && wrapper.children.length === 1 ? wrapper : footer;
}

// The stories tray strip at the top of the home feed. Its pagelet wrapper is a
// stable anchor; climb past single-child wrappers so its spacing collapses too.
function getStoriesTray() {
  const tray = document.querySelector('[data-pagelet="story_tray"]');
  if (!tray) return null;
  let el = tray;
  while (
    el.parentElement &&
    el.parentElement !== document.body &&
    el.parentElement.children.length === 1
  ) {
    el = el.parentElement;
  }
  return el;
}

// The DM inbox "Messages" header row (holds the title + Requests link). Anchor
// for the notes tray, which sits directly above it.
function getMessagesHeader() {
  const h1 = Array.from(document.querySelectorAll("h1")).find(
    (el) => el.textContent.trim() === "Messages"
  );
  return h1 ? h1.parentElement : null;
}

// The notes tray strip atop the DM inbox: the sibling right above the Messages
// header. Confirmed by the note bubbles' dialog triggers so we don't grab the
// inbox title bar instead.
function getNotesTray() {
  const header = getMessagesHeader();
  const candidate = header && header.previousElementSibling;
  if (!candidate || !candidate.querySelector('[aria-haspopup="dialog"]')) {
    return null;
  }
  return candidate;
}

// The whole right column. Anchored on the footer, climb to the highest ancestor
// that doesn't contain a feed post (<article>); its parent is the row that also
// holds the feed. Guarded on a feed post existing so the boundary is real — if
// the feed hasn't rendered yet we skip and retry on the next mutation.
function findSidebarRoot() {
  const footer = document.querySelector("._ab8b");
  if (!footer || !document.querySelector("article")) return null;

  let node = footer;
  while (
    node.parentElement &&
    node.parentElement !== document.body &&
    node.parentElement.tagName !== "MAIN" &&
    !node.parentElement.querySelector("article")
  ) {
    node = node.parentElement;
  }
  return node;
}

function applyFooterSpacing(on) {
  const existing = document.querySelector(`[${SPACER_ATTR}="true"]`);
  if (existing && (!on || existing !== getFooter())) {
    existing.style.removeProperty("margin-top");
    existing.removeAttribute(SPACER_ATTR);
  }
  if (!on) return;

  const footer = getFooter();
  if (!footer || footer.getAttribute(HIDDEN_ATTR) === "true") return;
  if (footer.getAttribute(SPACER_ATTR) === "true") return;
  footer.style.setProperty("margin-top", FOOTER_GAP);
  footer.setAttribute(SPACER_ATTR, "true");
}

// Pad the top of the feed when the stories tray is hidden. The feed is the
// element right after the (now hidden) tray wrapper in the center column.
function applyStoriesSpacing(on) {
  const existing = document.querySelector(`[${STORIES_SPACER_ATTR}="true"]`);
  const tray = on ? getStoriesTray() : null;
  const target = tray ? tray.nextElementSibling : null;

  if (existing && existing !== target) {
    existing.style.removeProperty("padding-top");
    existing.removeAttribute(STORIES_SPACER_ATTR);
  }
  if (!on || !target) return;
  if (target.getAttribute(STORIES_SPACER_ATTR) === "true") return;
  target.style.setProperty("padding-top", STORIES_GAP);
  target.setAttribute(STORIES_SPACER_ATTR, "true");
}

// Push the DM "Messages" header down when the notes tray above it is hidden.
function applyNotesSpacing(on) {
  const existing = document.querySelector(`[${NOTES_SPACER_ATTR}="true"]`);
  const target = on && getNotesTray() ? getMessagesHeader() : null;

  if (existing && existing !== target) {
    existing.style.removeProperty("margin-top");
    existing.removeAttribute(NOTES_SPACER_ATTR);
  }
  if (!on || !target) return;
  if (target.getAttribute(NOTES_SPACER_ATTR) === "true") return;
  target.style.setProperty("margin-top", NOTES_GAP);
  target.setAttribute(NOTES_SPACER_ATTR, "true");
}

function processSidebar() {
  if (!document.body) return;

  // Removing the whole column subsumes every other hide.
  if (hideSidebar) {
    const root = findSidebarRoot();
    if (root) {
      hideElement(root, "sidebar");
      return;
    }
    // Feed not ready yet — fall through and apply the safe piecewise hides so
    // there's no flash; the next scan retries the full-column removal.
  }

  if (hideHome || hideProfile) {
    const headings = Array.from(
      document.querySelectorAll("h4, span")
    ).filter((el) => el.textContent.trim() === "Suggested for you");

    for (const heading of headings) {
      const module = resolveModule(heading);
      if (!module || module.getAttribute(HIDDEN_ATTR) === "true") continue;

      const kind = classifyModule(module);
      if (kind === "home" ? hideHome : hideProfile) hideElement(module, kind);
    }
  }

  if (hideFooter) {
    const footer = getFooter();
    if (footer) hideElement(footer, "footer");
  }

  if (hideStories) {
    const tray = getStoriesTray();
    if (tray) hideElement(tray, "stories");
  }

  if (hideNotes) {
    const notes = getNotesTray();
    if (notes) hideElement(notes, "notes");
  }

  // Keep the switcher off the footer when the home list is gone but the footer
  // (and column) remain.
  const homeHidden = !!document.querySelector(`[${KIND_ATTR}="home"]`);
  applyFooterSpacing(homeHidden && !hideFooter && !hideSidebar);

  // Keep the first post off the top edge when the stories tray is gone.
  applyStoriesSpacing(hideStories);

  // Give the DM Messages header room when the notes tray above it is gone.
  applyNotesSpacing(hideNotes);
}

// Coalesce mutation bursts into one scan per frame. rAF runs before paint, so
// anything hidden here is hidden before it's drawn — no flash, no shift.
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    processSidebar();
  });
}

function initHideSuggested(
  home = false,
  profile = false,
  footer = false,
  sidebar = false,
  stories = false,
  notes = false
) {
  hideHome = !!home;
  hideProfile = !!profile;
  hideFooter = !!footer;
  hideSidebar = !!sidebar;
  hideStories = !!stories;
  hideNotes = !!notes;

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  // Reveal anything a now-disabled toggle previously hid, and drop spacing.
  document
    .querySelectorAll(`[${HIDDEN_ATTR}="true"]`)
    .forEach((el) => showElement(el));
  applyFooterSpacing(false);
  applyStoriesSpacing(false);
  applyNotesSpacing(false);

  if (
    !hideHome &&
    !hideProfile &&
    !hideFooter &&
    !hideSidebar &&
    !hideStories &&
    !hideNotes
  )
    return;

  // Hide anything already present, then watch for pieces IG inserts later.
  // Observe <html> so this works even before <body> exists (document_start).
  processSidebar();

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}


module.exports.initHideSuggested = initHideSuggested;
});


defineModule("features/search-cleaner/index.js", function (module, exports, require) {
// Hide Instagram recent searches section in the search dialog.
// We watch the DOM for the search overlay and hide the "Recent" header,
// the "Clear all" button, and the accompanying list.

let observer = null;

function hideRecentBlocks(root = document) {
  const recentHeadings = Array.from(root.querySelectorAll("h4")).filter(
    (h4) => h4.textContent?.trim().toLowerCase() === "recent"
  );

  recentHeadings.forEach((heading) => {
    // Hide the header row (contains the heading and "Clear all" action).
    const headerRow = heading.parentElement?.parentElement || heading.parentElement;
    if (headerRow) {
      headerRow.style.display = "none";
    }

    // Hide the list of recent items (typically the next sibling UL).
    const maybeList =
      headerRow?.nextElementSibling ||
      headerRow?.parentElement?.querySelector("ul");
    if (maybeList && maybeList.tagName?.toLowerCase() === "ul") {
      maybeList.style.display = "none";
    }
  });

  // Also hide the "Clear all" control if it is present anywhere else.
  const clearButtons = Array.from(
    root.querySelectorAll('[role="button"], button, div')
  ).filter((el) => el.textContent?.trim().toLowerCase() === "clear all");

  clearButtons.forEach((btn) => {
    const container = btn.closest("div") || btn;
    container.style.display = "none";
  });
}

function initHideRecentSearches(enabled = true) {
  // Clean up existing observer if disabling
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (!enabled) return;

  // Clean any previously hidden elements immediately.
  hideRecentBlocks();

  observer = new MutationObserver(() => hideRecentBlocks());
  observer.observe(document.body, { childList: true, subtree: true });
}



module.exports.initHideRecentSearches = initHideRecentSearches;
});


defineModule("features/message-edit-shortcut/index.js", function (module, exports, require) {
/**
 * Message Edit and Reply Shortcut Feature
 *
 * Quick Edit:  Ctrl/Cmd+Shift+Up - Edit the last message YOU sent.
 * Quick Reply: Ctrl/Cmd+Up       - Reply to the other person's messages.
 *   - First press: reply to most recent message.
 *   - Consecutive presses: walk up through older messages.
 *
 * Both happen instantly and flash-free — see ../_shared/dm-message-actions.js
 * for the (rewritten for Instagram's new DM DOM) detection and click pipeline.
 */

var { showToast } = require("ui/toast.js");
var { findLastSentMessage, findOtherPersonMessages, replyToMessage, editMessage, isDmComposerFocused } = require("features/_shared/dm-message-actions.js");

// Quick-reply navigation state.
let quickReplyIndex = 0;
let quickReplyResetTimer = null;
let currentConversationId = null;

function initMessageEditShortcut() {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "ArrowUp" || !(e.ctrlKey || e.metaKey)) return;
      // Only act when a DM message composer is focused (works in the docked DM
      // widget too, not just /direct/).
      if (!isDmComposerFocused()) return;

      const isQuickEdit = e.shiftKey;
      const isQuickReply = !e.shiftKey;

      chrome.storage.sync.get(
        { enableMessageEditShortcut: true, enableMessageReplyShortcut: true },
        (settings) => {
          if (isQuickEdit && !settings.enableMessageEditShortcut) return;
          if (isQuickReply && !settings.enableMessageReplyShortcut) return;

          e.preventDefault();
          e.stopPropagation();

          if (isQuickEdit) {
            resetQuickReply();
            handleQuickEdit();
          } else {
            handleQuickReply();
          }
        }
      );
    },
    true
  );
}

function resetQuickReply() {
  quickReplyIndex = 0;
  currentConversationId = null;
  if (quickReplyResetTimer) {
    clearTimeout(quickReplyResetTimer);
    quickReplyResetTimer = null;
  }
}

function handleQuickEdit() {
  const lastSent = findLastSentMessage();
  if (!lastSent) {
    showToast("No message to edit", { id: "instafn-edit-tooltip" });
    return;
  }

  editMessage(lastSent).then((ok) => {
    if (!ok) showToast("Quick edit failed", { id: "instafn-edit-tooltip" });
  });
}

function handleQuickReply() {
  const conversationId = window.location.pathname;

  // Restart navigation when the conversation changes.
  if (currentConversationId !== conversationId) {
    quickReplyIndex = 0;
    currentConversationId = conversationId;
  }

  // Reset to the most recent message after a short idle period.
  if (quickReplyResetTimer) clearTimeout(quickReplyResetTimer);
  quickReplyResetTimer = setTimeout(() => {
    quickReplyIndex = 0;
  }, 1500);

  const messages = findOtherPersonMessages();
  if (messages.length === 0) {
    quickReplyIndex = 0;
    showToast("No message to reply to", { id: "instafn-reply-tooltip" });
    return;
  }

  if (quickReplyIndex >= messages.length) {
    // Past the oldest — wrap back to the most recent.
    quickReplyIndex = 0;
  }

  const target = messages[quickReplyIndex];
  quickReplyIndex++;

  replyToMessage(target).then((ok) => {
    if (!ok) {
      quickReplyIndex = 0;
      showToast("Quick reply failed", { id: "instafn-reply-tooltip" });
    }
  });
}


module.exports.initMessageEditShortcut = initMessageEditShortcut;
});


defineModule("features/branding/index.js", function (module, exports, require) {
var { injectStylesheet } = require("utils/styleLoader.js");

function initBranding() {
  injectStylesheet(
    "content/features/branding/branding.css",
    "instafn-branding"
  );

  function updateBranding(element) {
    if (!element || element.dataset.instafnModified === "true") return;

    const originalText = element.textContent.trim();
    if (!originalText || originalText.includes("Instafn")) return;

    element.innerHTML = `${originalText} • 💽 Instafn by <a href="https://afn.im" target="_blank" rel="noopener noreferrer" class="instafn-link">afn.im</a>`;
    element.dataset.instafnModified = "true";
  }

  function checkAndUpdate() {
    // Check main footer
    const mainFooter = document.querySelector("._ab8i span");
    if (mainFooter) updateBranding(mainFooter);

    // Check profile footer - find span containing "Instagram from Meta"
    const profileFooter = document.querySelector('footer[role="contentinfo"]');
    if (profileFooter) {
      const spans = profileFooter.querySelectorAll("span");
      spans.forEach((span) => {
        if (span.textContent.includes("Instagram from Meta")) {
          updateBranding(span);
        }
      });
    }
  }

  // Check immediately and periodically
  checkAndUpdate();
  setInterval(checkAndUpdate, 500);

  // Also watch for DOM changes
  const observer = new MutationObserver(() => {
    checkAndUpdate();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}


module.exports.initBranding = initBranding;
});


defineModule("features/post-hover-info/index.js", function (module, exports, require) {
/**
 * Post Hover Info
 *
 * Instagram shows a like + comment count overlay when you hover a post card on a
 * profile grid. This feature adds the post's date (formatted using the feature's
 * own Date Format setting, default dd/mm/yy) with a calendar icon as another item
 * in that same counts list, cloning a count <li> so the date matches IG's exact
 * text styling.
 *
 * The date is derived directly from the post's shortcode in the card's link.
 * Instagram shortcodes are base64url-encoded media IDs, and a media ID embeds its
 * creation time (Snowflake-style: the high bits are milliseconds since IG's
 * epoch). Decoding the shortcode therefore yields the date with no API call, and
 * works uniformly on every grid — Posts, Reels, Tagged and Reposts. This matters
 * because only the Posts feed carries a `taken_at`; the Reels/Tagged/Reposts
 * GraphQL payloads omit any date field entirely, so there is nothing to read from
 * the network there. (Verified: shortcode-derived time matches the feed's
 * taken_at/created_at to within ~1s.)
 */

var { injectStylesheet } = require("utils/styleLoader.js");
var { formatExactTime } = require("features/exact-time-display/index.js");

const DATE_ITEM_CLASS = "instafn-post-hover-date-item";
const UL_FLAG_CLASS = "instafn-post-hover-ul";
const PROCESSED_ATTR = "data-instafn-hover-date";

// Solid calendar glyph (a filled body + two legs — no hollow areas, matching the
// filled-heart look). Uses currentColor; the CSS forces that to white since the
// <li>'s inherited color is IG's link-blue.
const CALENDAR_PATHS =
  '<rect x="3" y="5" width="18" height="16" rx="3"></rect><rect x="6.5" y="2" width="2.5" height="5" rx="1.25"></rect><rect x="15" y="2" width="2.5" height="5" rx="1.25"></rect>';
const CALENDAR_SVG =
  '<svg class="instafn-post-hover-cal" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  CALENDAR_PATHS +
  "</svg>";

let isEnabled = false;
let currentFormat = "dd/mm/yy";
let listenersWired = false;

// Reuses the Exact Time formatter so date AND date+time formats are available,
// and the same format keys are editable in either feature's settings.
function formatDate(takenAt, format) {
  return formatExactTime(new Date(takenAt * 1000).toISOString(), format);
}

// ---------------------------------------------------------------------------
// Shortcode → date
// ---------------------------------------------------------------------------

// IG shortcodes are base64url over this alphabet; decoding gives the media id.
const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Media ids are Snowflake-like: (id >> 23) ms since this epoch is the post time.
const IG_EPOCH_MS = 1314220021721n;

// Decode the shortcode to its media id and pull the embedded creation time.
// Returns unix seconds, or null if the code isn't a decodable shortcode or the
// derived time is implausible (guards against ad/long/opaque codes).
function takenAtFromShortcode(code) {
  if (!code) return null;
  let id = 0n;
  for (let i = 0; i < code.length; i++) {
    const v = SHORTCODE_ALPHABET.indexOf(code[i]);
    if (v === -1) return null;
    id = id * 64n + BigInt(v);
  }
  const seconds = Number(((id >> 23n) + IG_EPOCH_MS) / 1000n);
  // Sane range: 2010-01-01 .. 2035-01-01.
  if (seconds < 1262304000 || seconds > 2051222400) return null;
  return seconds;
}

function extractCode(href) {
  if (!href) return null;
  // Grid links look like /<user>/p/<code>/ or /<user>/reel/<code>/ (and /tv/).
  const m = href.match(/\/(?:p|reel|tv)\/([^/?#]+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

// Listeners are attached once and gated on `isEnabled`, so the feature toggles
// live without ever running while disabled. There is intentionally no standing
// page-wide MutationObserver: the date is computed from the card's own link on
// hover, so the DOM work only runs on hover — never as a constant poll.
function wireListeners() {
  if (listenersWired) return;
  listenersWired = true;
  document.addEventListener("mouseover", onMouseOver, true);
}

// ---------------------------------------------------------------------------
// Overlay injection
// ---------------------------------------------------------------------------

// Inject only when a card is actually hovered. IG builds the count overlay a
// frame or two after the pointer enters, so we look now and again shortly after;
// injectForCountsList is idempotent, so the repeats are free.
function onMouseOver(e) {
  if (!isEnabled) return;
  const link = e.target.closest?.(
    'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
  );
  if (!link) return;
  injectIntoCard(link);
  requestAnimationFrame(() => injectIntoCard(link));
  setTimeout(() => injectIntoCard(link), 60);
  setTimeout(() => injectIntoCard(link), 160);
}

function injectIntoCard(link) {
  if (!isEnabled || !link.isConnected) return;
  // Every profile grid (Posts, Reels, Tagged, Reposts) builds the same <ul> of
  // count <li>s in the card's hover overlay, so one path covers them all.
  const ul = link.querySelector("ul");
  if (ul) injectForCountsList(ul);
}

// Build the date as a sibling <li> of the like/comment counts by cloning one of
// them — that's the most reliable way to inherit IG's exact text styling (font,
// size, weight, color). We then swap the cloned item's masked icon glyph for our
// own calendar SVG and reorder it to sit before the date text.
function buildDateListItem(templateLi, takenAt) {
  const li = templateLi.cloneNode(true);
  li.classList.add(DATE_ITEM_CLASS);
  li.removeAttribute(PROCESSED_ATTR);

  const textNode = li.querySelector(".html-span");
  if (textNode) textNode.textContent = formatDate(takenAt, currentFormat);

  // Each count <li> is [textWrapperSpan, iconSpan]; the icon is rendered via IG
  // mask classes (a heart/comment). Repurpose it as our calendar and move it
  // ahead of the text so the row reads [icon] [date].
  const iconSpan = li.lastElementChild;
  if (iconSpan && iconSpan !== li.firstElementChild) {
    iconSpan.removeAttribute("style");
    iconSpan.className = "instafn-post-hover-cal-wrap";
    iconSpan.innerHTML = CALENDAR_SVG;
    li.insertBefore(iconSpan, li.firstElementChild);
  }
  return li;
}

// The hover overlay is a <ul> of count <li>s sitting inside the card's <a>.
// We append the date as another <li> in that same list.
function injectForCountsList(ul) {
  if (!ul || ul.getAttribute(PROCESSED_ATTR) === "1") return;

  const link = ul.closest('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
  if (!link) return;
  // Guard against matching unrelated lists: the counts overlay always has <li>s.
  const templateLi = ul.querySelector(":scope > li");
  if (!templateLi) return;

  const takenAt = takenAtFromShortcode(extractCode(link.getAttribute("href")));
  if (takenAt == null) return;

  ul.classList.add(UL_FLAG_CLASS);
  ul.appendChild(buildDateListItem(templateLi, takenAt));
  ul.setAttribute(PROCESSED_ATTR, "1");
}

// Re-scan overlays currently in the DOM (used on init and after a live format
// change so any already-open overlay re-renders immediately).
function refreshExistingOverlays() {
  document
    .querySelectorAll(
      'a[href*="/p/"] ul, a[href*="/reel/"] ul, a[href*="/tv/"] ul'
    )
    .forEach(injectForCountsList);
}

function removeInjectedDates() {
  document.querySelectorAll(`.${DATE_ITEM_CLASS}`).forEach((el) => el.remove());
  document.querySelectorAll(`ul[${PROCESSED_ATTR}="1"]`).forEach((ul) => {
    ul.removeAttribute(PROCESSED_ATTR);
    ul.classList.remove(UL_FLAG_CLASS);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Wire the hover listener as early as possible (gated on the setting) so dates
// appear on the very first card the user hovers after load.
function setupPostHoverInfoEarly() {
  chrome.storage.sync.get({ enablePostHoverInfo: false }, (settings) => {
    if (settings.enablePostHoverInfo) {
      isEnabled = true;
      wireListeners();
    }
  });
}

function initPostHoverInfo(enabled, format = "dd/mm/yy") {
  isEnabled = !!enabled;
  currentFormat = format || "dd/mm/yy";

  if (!isEnabled) {
    removeInjectedDates();
    return;
  }

  injectStylesheet(
    "content/features/post-hover-info/post-hover-info.css",
    "instafn-post-hover-info"
  );
  wireListeners();

  // Re-render existing dates so a live format change is reflected immediately.
  removeInjectedDates();
  refreshExistingOverlays();
}


module.exports.setupPostHoverInfoEarly = setupPostHoverInfoEarly;
module.exports.initPostHoverInfo = initPostHoverInfo;
});


defineModule("features/profile-grid-columns/index.js", function (module, exports, require) {
/**
 * Profile Grid Columns
 *
 * Lets the user choose how many columns the profile grid uses for Posts, Reels,
 * Reposts and Tagged. Instagram hardcodes three cells per row in the DOM, so the
 * actual reflow is done in CSS (see profile-grid-columns.css) by dissolving each
 * row and re-gridding its parent. This module just drives that CSS: it injects
 * the stylesheet and toggles a `data-instafn-grid-cols` attribute plus a
 * `--instafn-grid-cols` custom property on <html>.
 *
 * The override is applied only while the user is on a profile page and only when
 * they've picked a fixed column count. The "default" option (and any unset value)
 * removes the attribute entirely so Instagram's native, responsive layout is left
 * untouched; a chosen number — including 3 — forces a fixed grid of that many
 * columns. Off profile pages (explore, search, hashtag grids, etc.) it never
 * engages.
 */

var { injectStylesheet } = require("utils/styleLoader.js");

const STYLE_PATH = "content/features/profile-grid-columns/profile-grid-columns.css";
const STYLE_KEY = "instafn-profile-grid-columns";
const ROOT_ATTR = "data-instafn-grid-cols";
const COL_VAR = "--instafn-grid-cols";

// "default" means: don't override anything, leave Instagram's native (responsive)
// layout alone. Any number — including 3 — forces a fixed grid of that many
// columns.
const NATIVE = "default";
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 8;

let currentColumns = NATIVE; // NATIVE or a clamped integer.

function normalizeColumns(value) {
  if (value === NATIVE || value == null) return NATIVE;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return NATIVE;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, n));
}

// Instagram profile tabs all live under /<user>/ (Posts) or /<user>/<tab>/. We
// only want to touch those grids, never the visually similar explore/search/
// hashtag grids, so we whitelist profile-tab shapes and skip reserved routes.
const RESERVED_FIRST_SEGMENTS = new Set([
  "explore", "reels", "direct", "stories", "accounts", "p", "reel", "tv",
  "about", "settings", "emails", "challenge", "oauth", "ads", "legal",
  "privacy", "terms", "developer", "directory", "web", "your_activity",
  "lite", "notifications", "api",
]);
const PROFILE_TAB_SEGMENTS = new Set([
  "reels", "tagged", "reposts", "saved", "feed",
]);

function isProfileGridPage(pathname = window.location.pathname) {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return false; // home feed
  if (RESERVED_FIRST_SEGMENTS.has(segs[0].toLowerCase())) return false;
  if (segs.length === 1) return true; // /<user>/ — Posts tab
  if (segs.length === 2 && PROFILE_TAB_SEGMENTS.has(segs[1].toLowerCase())) {
    return true; // /<user>/reels, /tagged, /reposts, ...
  }
  return false;
}

function applyState() {
  const root = document.documentElement;
  const shouldApply = currentColumns !== NATIVE && isProfileGridPage();

  if (!shouldApply) {
    root.removeAttribute(ROOT_ATTR);
    root.style.removeProperty(COL_VAR);
    return;
  }

  injectStylesheet(STYLE_PATH, STYLE_KEY);
  root.style.setProperty(COL_VAR, String(currentColumns));
  root.setAttribute(ROOT_ATTR, String(currentColumns));
}

// Called on load and whenever the setting changes.
function initProfileGridColumns(columns) {
  currentColumns = normalizeColumns(columns);
  applyState();
}

// Called on SPA navigation so the override engages/disengages as the user moves
// between profile pages and the rest of Instagram.
function refreshProfileGridColumns() {
  applyState();
}


module.exports.initProfileGridColumns = initProfileGridColumns;
module.exports.refreshProfileGridColumns = refreshProfileGridColumns;
});


defineModule("features/carousel-dot-drag/index.js", function (module, exports, require) {
/**
 * Carousel Dot Drag-to-Scrub
 *
 * Mimics the mobile gesture where dragging across a post's dot indicator scrubs
 * through the carousel. Drag right → advance to the next image; drag left → go
 * back. Each ~step of horizontal movement snaps one image in that direction.
 *
 * Implementation note: instead of fighting React by mutating the slide
 * transforms directly, we drive Instagram's own "Next" / "Go back" carousel
 * buttons. Clicking them triggers IG's native snap-scroll animation and gives us
 * free bounds-clamping — at the first slide there's no back button, at the last
 * there's no next button, so an out-of-range step is a harmless no-op.
 *
 * The dots strip is tiny, so we setPointerCapture on it: the user will almost
 * always drag their cursor off the dots, and capture keeps the move/up events
 * flowing to us anyway.
 */

const STYLE_ID = "instafn-carousel-dot-drag-style";
const BODY_ENABLED_CLASS = "instafn-cdd-enabled";
const BODY_DRAGGING_CLASS = "instafn-cdd-dragging";
// Applied while the bare cursor is hovering a carousel's dots region. The dots
// strip is usually pointer-events:none, so a `cursor` on ._acnc never wins — the
// element behind it does. We hit-test the pointer instead and force the cursor
// globally (same !important trick as the dragging state).
const BODY_HOVER_CLASS = "instafn-cdd-hover";
// Applied to the carousel root during a drag to kill IG's slide transition, so
// each step jumps instantly instead of animating.
const SNAP_CLASS = "instafn-cdd-snap";

// Fallback px-per-slide when the strip geometry is unusable. Normally the step
// is derived from the dots strip itself (see dragStepPx) so that dragging across
// the width of the dots traverses the whole carousel — a natural 1:1 feel
// instead of a fixed distance that overshoots on long posts.
const DRAG_STEP_PX = 22;
// Don't let a tiny/cramped strip make the scrub hair-trigger sensitive.
const MIN_DRAG_STEP_PX = 10;
// Pivot-style precision: the per-slide travel grows with how far the cursor is
// (vertically) from the dots. At the dots it's the base step (strip-width 1:1);
// roughly every PRECISION_FALLOFF_PX of vertical offset adds one base-step of
// travel per slide, so pulling away gives finer scrubbing.
const PRECISION_FALLOFF_PX = 90;

// The dots strip is only a few px tall and the dots themselves are typically
// pointer-events:none, so we can't rely on the event target. Hit-test the
// pointer against the strip's box, padded so the tiny target is grabbable.
const HIT_PAD_X = 10;
const HIT_PAD_Y = 14;

let enabled = false;

// Active-drag state
let dragging = false;
let dotsEl = null;
let carouselRoot = null;
let activePointerId = null;
let lastX = 0;
let accum = 0; // signed drag distance not yet consumed by a step
// Base px of horizontal drag per one-slide step at the dots' own scale: strip
// width / gaps between dots, so a full strip-width drag spans the carousel. Set
// in onPointerDown; scaled up by vertical distance in onPointerMove.
let baseStepPx = DRAG_STEP_PX;
// The dots strip's vertical centre, captured at grab time, for the precision
// falloff measured from the cursor's distance to the dots.
let stripCenterY = 0;
// Live per-slide step (base scaled by vertical distance), updated each move and
// read by the frame pump.
let dragStepPx = DRAG_STEP_PX;
// Frame pump: drains banked drag one step per frame so a fast flick traverses
// many slides reliably (one click per frame → IG re-renders between each).
let pumpScheduled = false;

// Hover state: whether the bare cursor is currently over a dots region.
let hovering = false;
let hoverRafPending = false;
let lastHoverX = 0;
let lastHoverY = 0;

// ---------------------------------------------------------------------------
// Style (cursor affordance + drag UX)
// ---------------------------------------------------------------------------

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    body.${BODY_HOVER_CLASS},
    body.${BODY_HOVER_CLASS} * { cursor: col-resize !important; }
    body.${BODY_DRAGGING_CLASS},
    body.${BODY_DRAGGING_CLASS} * {
      cursor: col-resize !important;
      user-select: none !important;
    }
    .${SNAP_CLASS}, .${SNAP_CLASS} * {
      transition: none !important;
      transition-duration: 0s !important;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Carousel detection
// ---------------------------------------------------------------------------

function countDots(strip) {
  return strip.querySelectorAll(":scope > ._acnb").length;
}

// Measure the real dot cluster (not the post-wide ._acnc box): the pitch between
// adjacent dots, and the dots' vertical centre. pitch = centre-to-centre span of
// the first→last dot divided by the gaps, i.e. how far one slide is on screen.
function measureDots(strip) {
  const dots = strip.querySelectorAll(":scope > ._acnb");
  if (dots.length < 2) return { pitch: 0, centerY: 0 };
  const first = dots[0].getBoundingClientRect();
  const last = dots[dots.length - 1].getBoundingClientRect();
  const firstCx = first.left + first.width / 2;
  const lastCx = last.left + last.width / 2;
  const pitch = (lastCx - firstCx) / (dots.length - 1);
  const centerY = first.top + first.height / 2;
  return { pitch, centerY };
}

// Resolve the dots strip for a pointerdown event. A carousel strip must have ≥2
// dot children so we don't mistake some other underscore-classed element for a
// carousel.
function getDotsContainer(e) {
  // Fast path: pointer landed directly on the strip or a dot.
  const direct = e.target?.closest?.("._acnc");
  if (direct && countDots(direct) >= 2) return direct;

  // Fallback: the dots are usually pointer-events:none, so the real event
  // target is whatever sits behind them. Hit-test the pointer coordinates
  // against each strip's (padded) box instead.
  const { clientX: x, clientY: y } = e;
  for (const strip of document.querySelectorAll("._acnc")) {
    if (countDots(strip) < 2) continue;
    const r = strip.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (
      x >= r.left - HIT_PAD_X &&
      x <= r.right + HIT_PAD_X &&
      y >= r.top - HIT_PAD_Y &&
      y <= r.bottom + HIT_PAD_Y
    ) {
      return strip;
    }
  }
  return null;
}

// Walk up from the dots strip to the first ancestor that also contains this
// carousel's nav button. That ancestor is the post/carousel root, which scopes
// our button queries to the correct carousel even with many posts on screen.
function findCarouselRoot(strip) {
  let el = strip.parentElement;
  let depth = 0;
  while (el && depth < 10) {
    if (
      el.querySelector(
        'button[aria-label="Next"], button[aria-label="Go back"], button._afxw, button._afxv'
      )
    ) {
      return el;
    }
    el = el.parentElement;
    depth++;
  }
  return null;
}

// Re-queried live on every step: the back button is absent on the first slide
// and the next button is absent on the last, which is how we get clamping.
function resolveButton(root, dir) {
  if (!root) return null;
  const sel =
    dir > 0
      ? '[aria-label="Next"], button._afxw'
      : '[aria-label="Go back"], [aria-label="Previous"], button._afxv';
  const el = root.querySelector(sel);
  if (!el) return null;
  return el.closest("button") || (el.tagName === "BUTTON" ? el : null);
}

// Returns true if a slide actually changed. At a bound the direction's button
// is absent (no Next on the last slide, no Back on the first), so we report
// false and the caller drops any banked drag instead of letting it pile up.
function step(dir) {
  const btn = resolveButton(carouselRoot, dir);
  if (!btn) return false;
  btn.click();
  return true;
}

// ---------------------------------------------------------------------------
// Drag handling
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!enabled || e.button !== 0 || dragging) return;

  const strip = getDotsContainer(e);
  if (!strip) return;

  const root = findCarouselRoot(strip);
  if (!root) return; // dots without a navigable carousel — leave alone

  dragging = true;
  dotsEl = strip;
  carouselRoot = root;
  activePointerId = e.pointerId;
  lastX = e.clientX;
  accum = 0;

  // Map drag distance to the dots' own scale. The ._acnc strip is as wide as the
  // post, but the dots are a small centred cluster — so measure the dots
  // themselves (first dot centre → last dot centre) and use the inter-dot pitch
  // as the per-slide step. Dragging across the actual dots then spans the
  // carousel, regardless of where in the strip you grab.
  const { pitch, centerY } = measureDots(strip);
  baseStepPx = pitch > 0 ? Math.max(MIN_DRAG_STEP_PX, pitch) : DRAG_STEP_PX;
  stripCenterY = centerY;

  // Disable the carousel's slide transition for the duration of the drag so
  // every step jumps instantly. Restored on release.
  root.classList.add(SNAP_CLASS);

  // Keep move/up events coming even as the cursor leaves the tiny dots strip.
  try {
    strip.setPointerCapture(e.pointerId);
  } catch (_) {
    /* not all pointer types support capture */
  }

  document.body.classList.add(BODY_DRAGGING_CLASS);

  // Prevent the browser's native image-drag / text selection from starting.
  e.preventDefault();
  e.stopPropagation();

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
}

function onPointerMove(e) {
  if (!dragging || e.pointerId !== activePointerId) return;

  const dx = e.clientX - lastX;
  if (dx === 0) return;
  lastX = e.clientX;

  // Pivot/lever precision: scale the per-slide travel by how far the cursor is
  // (vertically) from the dots. Right at the dots it's the base step (one
  // strip-width spans the carousel); pull away and each slide needs more drag,
  // giving fine control. Recomputed each move so drifting in Y adjusts live.
  const dy = Math.abs(e.clientY - stripCenterY);
  dragStepPx = baseStepPx * (1 + dy / PRECISION_FALLOFF_PX);

  // Reversing direction clears any banked distance from the previous direction,
  // so a change of direction registers after one fresh step's worth of drag
  // rather than first having to pay off the old leftover (which felt sticky,
  // especially when reversing off the last/first slide).
  if ((dx > 0) !== (accum >= 0)) accum = 0;
  accum += dx;

  // Apply one step now for immediate response, then let the frame pump drain any
  // remaining banked distance one step per frame. Firing every banked step here
  // (synchronously) would be swallowed: IG advances via a React state update, so
  // multiple clicks in one tick all read the same pre-render index and collapse
  // into a single slide — which is why a fast flick used to move only one.
  applyStep();
  schedulePump();

  e.preventDefault();
  e.stopPropagation();
}

// Consume one slide's worth of banked drag, if any. At a bound the button is
// absent, so we drop the banked distance instead of letting it pile up (keeps a
// reverse drag responsive). At most one click per call → never collapses.
function applyStep() {
  if (accum >= dragStepPx) {
    if (step(1)) accum -= dragStepPx;
    else accum = 0;
  } else if (accum <= -dragStepPx) {
    if (step(-1)) accum += dragStepPx;
    else accum = 0;
  }
}

function pumpStep() {
  pumpScheduled = false;
  if (!dragging) return;
  applyStep();
  schedulePump();
}

// Schedule a pump frame only while a whole step is still banked.
function schedulePump() {
  if (pumpScheduled || !dragging) return;
  if (accum < dragStepPx && accum > -dragStepPx) return;
  pumpScheduled = true;
  requestAnimationFrame(pumpStep);
}

function onPointerUp(e) {
  if (!dragging) return;
  if (e && activePointerId !== null && e.pointerId !== activePointerId) return;

  if (dotsEl && activePointerId !== null) {
    try {
      dotsEl.releasePointerCapture(activePointerId);
    } catch (_) {
      /* ignore */
    }
  }

  if (carouselRoot) carouselRoot.classList.remove(SNAP_CLASS);

  dragging = false;
  dotsEl = null;
  carouselRoot = null;
  activePointerId = null;
  accum = 0;

  document.body.classList.remove(BODY_DRAGGING_CLASS);

  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", onPointerUp, true);
}

// ---------------------------------------------------------------------------
// Hover cursor
// ---------------------------------------------------------------------------

// True if (x, y) falls within any navigable carousel's padded dots box. Same
// coordinate hit-test as the drag fallback, used to drive the hover cursor
// because the dots strip itself is pointer-events:none.
function isOverDots(x, y) {
  for (const strip of document.querySelectorAll("._acnc")) {
    if (countDots(strip) < 2) continue;
    const r = strip.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (
      x >= r.left - HIT_PAD_X &&
      x <= r.right + HIT_PAD_X &&
      y >= r.top - HIT_PAD_Y &&
      y <= r.bottom + HIT_PAD_Y
    ) {
      return true;
    }
  }
  return false;
}

function setHovering(next) {
  if (next === hovering) return;
  hovering = next;
  document.body.classList.toggle(BODY_HOVER_CLASS, next);
}

// Throttled to one querySelectorAll per animation frame so the global
// pointermove listener stays cheap.
function evaluateHover() {
  hoverRafPending = false;
  if (!enabled || dragging) {
    setHovering(false);
    return;
  }
  setHovering(isOverDots(lastHoverX, lastHoverY));
}

function onHoverMove(e) {
  if (!enabled || dragging) return;
  lastHoverX = e.clientX;
  lastHoverY = e.clientY;
  if (hoverRafPending) return;
  hoverRafPending = true;
  requestAnimationFrame(evaluateHover);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function initCarouselDotDrag(isEnabled) {
  enabled = !!isEnabled;

  if (enabled) {
    ensureStyle();
    document.body?.classList.add(BODY_ENABLED_CLASS);
  } else {
    document.body?.classList.remove(BODY_ENABLED_CLASS);
    // Tear down any in-flight drag if toggled off mid-gesture.
    if (dragging) onPointerUp();
    setHovering(false);
  }

  // Listeners are attached once; the `enabled` flag gates behavior so the
  // feature can be toggled live without leaking handlers.
  if (initCarouselDotDrag._wired) return;
  initCarouselDotDrag._wired = true;

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onHoverMove, { passive: true });
}


module.exports.initCarouselDotDrag = initCarouselDotDrag;
});


defineModule("features/follow-analyzer/index.js", function (module, exports, require) {
var injectScanButton = require("features/follow-analyzer/ui.js").injectScanButton;
var removeScanButton = require("features/follow-analyzer/ui.js").removeScanButton;
var openModal = require("features/follow-analyzer/ui.js").openModal;
var createFollowButton = require("features/follow-analyzer/ui.js").createFollowButton;
var renderScanButton = require("features/follow-analyzer/ui.js").renderScanButton;
var confirmWithModal = require("features/follow-analyzer/ui.js").confirmWithModal;
var initFollowAnalyzerEarly = require("features/follow-analyzer/ui.js").initFollowAnalyzerEarly;
var setupScanButtonObserver = require("features/follow-analyzer/ui.js").setupScanButtonObserver;
var resetRetryCount = require("features/follow-analyzer/ui.js").resetRetryCount;
var getCurrentUsername = require("features/follow-analyzer/ui.js").getCurrentUsername;
var setScanButtonEnabled = require("features/follow-analyzer/ui.js").setScanButtonEnabled;
var fetchUserInfo = require("features/follow-analyzer/logic.js").fetchUserInfo;
var updateFriendship = require("features/follow-analyzer/logic.js").updateFriendship;
var getCurrentUser = require("features/follow-analyzer/logic.js").getCurrentUser;
var getProfileUsernameFromPath = require("features/follow-analyzer/logic.js").getProfileUsernameFromPath;
var getMeCached = require("features/follow-analyzer/logic.js").getMeCached;
var isOwnProfile = require("features/follow-analyzer/logic.js").isOwnProfile;
var fetchFriendList = require("features/follow-analyzer/logic.js").fetchFriendList;
var computeFollowAnalysis = require("features/follow-analyzer/logic.js").computeFollowAnalysis;
var scanFollowersAndFollowing = require("features/follow-analyzer/logic.js").scanFollowersAndFollowing;
var extractUsernames = require("features/follow-analyzer/logic.js").extractUsernames;
var loadPreviousSnapshot = require("features/follow-analyzer/logic.js").loadPreviousSnapshot;
var saveSnapshot = require("features/follow-analyzer/logic.js").saveSnapshot;
var getProfilePicData = require("features/follow-analyzer/logic.js").getProfilePicData;


module.exports.injectScanButton = injectScanButton;
module.exports.removeScanButton = removeScanButton;
module.exports.openModal = openModal;
module.exports.createFollowButton = createFollowButton;
module.exports.renderScanButton = renderScanButton;
module.exports.confirmWithModal = confirmWithModal;
module.exports.initFollowAnalyzerEarly = initFollowAnalyzerEarly;
module.exports.setupScanButtonObserver = setupScanButtonObserver;
module.exports.resetRetryCount = resetRetryCount;
module.exports.getCurrentUsername = getCurrentUsername;
module.exports.setScanButtonEnabled = setScanButtonEnabled;
module.exports.fetchUserInfo = fetchUserInfo;
module.exports.updateFriendship = updateFriendship;
module.exports.getCurrentUser = getCurrentUser;
module.exports.getProfileUsernameFromPath = getProfileUsernameFromPath;
module.exports.getMeCached = getMeCached;
module.exports.isOwnProfile = isOwnProfile;
module.exports.fetchFriendList = fetchFriendList;
module.exports.computeFollowAnalysis = computeFollowAnalysis;
module.exports.scanFollowersAndFollowing = scanFollowersAndFollowing;
module.exports.extractUsernames = extractUsernames;
module.exports.loadPreviousSnapshot = loadPreviousSnapshot;
module.exports.saveSnapshot = saveSnapshot;
module.exports.getProfilePicData = getProfilePicData;
});


defineModule("features/follow-analyzer/logic.js", function (module, exports, require) {
const SCAN_STORAGE_KEY = "instafn_follow_snapshot";

async function fetchUserInfo(username) {
  try {
    const response = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
        username
      )}`,
      {
        credentials: "include",
        headers: {
          "X-IG-App-ID": "936619743392459",
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          "Rate limited by Instagram (HTTP 429). Please try again in 2-3 hours."
        );
      }
      if (response.status === 404) {
        return {
          username,
          fullName: username,
          profilePic: null,
          isPrivate: false,
          isVerified: false,
          isFollowed: false,
          isFollowing: false,
          id: null,
          isDeactivated: true,
        };
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const info = await response.json();
    const user = info?.data?.user;
    if (user) {
      return {
        username: user.username,
        fullName: user.full_name,
        profilePic: user.profile_pic_url_hd || user.profile_pic_url,
        isPrivate: user.is_private,
        isVerified: user.is_verified,
        isFollowed: user.followed_by_viewer,
        isFollowing: user.follows_viewer,
        id: user.id || user.pk,
      };
    }
  } catch (_) {}
  return null;
}

async function updateFriendship(userId, friendshipAction) {
  const csrftoken = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) ||
    [])[1];
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.instagram.com/",
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-IG-WWW-Claim": "0",
  };
  if (csrftoken) headers["X-CSRFToken"] = decodeURIComponent(csrftoken);

  const action = friendshipAction ? "create" : "destroy";
  const actionText = friendshipAction ? "follow" : "unfollow";

  const response = await fetch(
    `https://www.instagram.com/api/v1/friendships/${action}/${userId}/`,
    {
      method: "POST",
      credentials: "include",
      headers,
      body: "target_user_id=" + userId,
    }
  );
  if (!response.ok) throw new Error(`${actionText} failed: ${response.status}`);
  return response.json();
}

async function safeFetchJson(url) {
  const csrftoken = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) ||
    [])[1];
  const headers = {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.instagram.com/",
    "X-IG-App-ID": "936619743392459",
  };
  if (csrftoken) headers["X-CSRFToken"] = decodeURIComponent(csrftoken);

  const resp = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers,
  });
  if (!resp.ok) {
    if (resp.status === 429) {
      throw new Error(
        "Rate limited by Instagram (HTTP 429). Please try again in 2-3 hours."
      );
    }
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp.json();
}

async function getCurrentUser() {
  try {
    const data = await safeFetchJson(
      "https://www.instagram.com/api/v1/accounts/edit/web_form_data/"
    );
    const username = data?.form_data?.username || data?.user?.username;
    const userId = String(data?.user?.pk || data?.user?.id || "");
    if (username && userId) return { username, userId };
  } catch (_) {}

  try {
    const data = await safeFetchJson(
      "https://www.instagram.com/api/v1/accounts/current_user/"
    );
    const username = data?.user?.username;
    const userId = String(data?.user?.pk || data?.user?.id || "");
    if (username && userId) return { username, userId };
  } catch (_) {}

  try {
    const path = window.location.pathname;
    const m = path.match(/^\/([^\/]+)\/?$/);
    if (m) {
      const username = m[1];
      const info = await safeFetchJson(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
          username
        )}`
      );
      const userId = String(info?.data?.user?.id || "");
      if (username && userId) return { username, userId };
    }
  } catch (_) {}

  throw new Error("Instafn: Could not determine current user");
}

// Profile sub-tabs that still render the same profile header (and so should
// keep reporting the profile's username, e.g. /username/reels/, /username/tagged/).
const PROFILE_SUBTABS = new Set([
  "reels",
  "tagged",
  "saved",
  "channel",
  "feed",
  "reposts",
]);

function getProfileUsernameFromPath() {
  const segments = location.pathname.split("/").filter(Boolean);
  if (segments.length === 1) return segments[0];
  if (segments.length === 2 && PROFILE_SUBTABS.has(segments[1].toLowerCase())) {
    return segments[0];
  }
  return null;
}

let cachedMe = null;
let meCacheTime = 0;
const ME_CACHE_DURATION = 5 * 60 * 1000;

async function getMeCached() {
  const now = Date.now();
  if (cachedMe && now - meCacheTime < ME_CACHE_DURATION) return cachedMe;
  try {
    cachedMe = await getCurrentUser();
    meCacheTime = now;
  } catch (_) {}
  return cachedMe;
}

async function isOwnProfile() {
  const username = getProfileUsernameFromPath();
  if (!username) return false;
  const me = await getMeCached();
  if (!me) return false;
  return username.toLowerCase() === me.username.toLowerCase();
}

async function fetchFriendList(userId, type) {
  const results = [];
  let cursor = null;
  let safety = 0;

  while (safety < 100) {
    safety++;
    const params = new URLSearchParams();
    params.set("count", "200");
    if (cursor) params.set("max_id", cursor);

    const url = `https://www.instagram.com/api/v1/friendships/${encodeURIComponent(
      userId
    )}/${type}/?${params.toString()}`;
    const data = await safeFetchJson(url);
    const users = data?.users || data?.profiles || [];

    for (const u of users) {
      const username = u?.username;
      const pk = String(u?.pk || u?.id || "");
      const profilePicUrl = u?.profile_pic_url || u?.profile_picture_url || "";
      const fullName = u?.full_name || "";
      const isPrivate = u?.is_private || false;
      const isVerified = u?.is_verified || false;
      // Instagram flags are viewer-relative:
      // followed_by_viewer => viewer follows target
      // follows_viewer     => target follows viewer
      let isFollowing =
        typeof u?.followed_by_viewer === "boolean"
          ? u.followed_by_viewer
          : type === "following";
      let isFollowed =
        typeof u?.follows_viewer === "boolean"
          ? u.follows_viewer
          : type === "followers";

      if (username) {
        let profilePicBase64 = null;
        if (profilePicUrl) {
          try {
            profilePicBase64 = await convertImageToBase64(profilePicUrl);
          } catch (err) {}
        }
        results.push({
          username,
          id: pk,
          profilePicUrl,
          profilePicBase64,
          fullName,
          isPrivate,
          isVerified,
          isFollowed,
          isFollowing,
        });
      }
    }

    const next = data?.next_max_id || data?.next_max_id || null;
    if (!next) break;
    cursor = String(next);
  }
  return results;
}

async function convertImageToBase64(url) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return null;
  }
}

function toSet(arr) {
  const s = new Set();
  for (const x of arr) s.add(x.username);
  return s;
}

function extractUsernames(data) {
  if (!data || !Array.isArray(data)) return [];
  return data.map((u) => (typeof u === "string" ? u : u.username));
}

function processPreviousData(prev) {
  if (!prev || !prev.current)
    return { prevFollowers: new Set(), prevFollowing: new Set() };
  const prevFollowers = new Set(extractUsernames(prev.current.followers));
  const prevFollowing = new Set(extractUsernames(prev.current.following));
  return { prevFollowers, prevFollowing };
}

function getProfilePicData(username, cachedData) {
  if (!cachedData) return null;
  const follower = cachedData.followers?.find((u) => u.username === username);
  if (follower) return follower;
  const following = cachedData.following?.find((u) => u.username === username);
  if (following) return following;
  return null;
}

async function loadPreviousSnapshot() {
  try {
    const me = await getCurrentUser();
    return await new Promise((resolve) => {
      try {
        chrome.storage.local.get([SCAN_STORAGE_KEY], (obj) => {
          const current = obj?.[SCAN_STORAGE_KEY] || null;
          chrome.storage.local.get([`${SCAN_STORAGE_KEY}_prev`], (prevObj) => {
            const previous = prevObj?.[`${SCAN_STORAGE_KEY}_prev`] || null;
            const filteredCurrent =
              current && current.username === me.username ? current : null;
            const filteredPrevious =
              previous && previous.username === me.username ? previous : null;
            resolve({ current: filteredCurrent, previous: filteredPrevious });
          });
        });
      } catch (_) {
        resolve({ current: null, previous: null });
      }
    });
  } catch (_) {
    return { current: null, previous: null };
  }
}

async function saveSnapshot(snapshot) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([SCAN_STORAGE_KEY], (obj) => {
        const current = obj?.[SCAN_STORAGE_KEY];
        if (current && current.username === snapshot.username) {
          chrome.storage.local.set(
            { [`${SCAN_STORAGE_KEY}_prev`]: current },
            () => {
              chrome.storage.local.set({ [SCAN_STORAGE_KEY]: snapshot }, () =>
                resolve()
              );
            }
          );
        } else {
          chrome.storage.local.set({ [SCAN_STORAGE_KEY]: snapshot }, () =>
            resolve()
          );
        }
      });
    } catch (_) {
      resolve();
    }
  });
}

async function computeFollowAnalysis() {
  const me = await getCurrentUser();
  const [followers, following] = await Promise.all([
    fetchFriendList(me.userId, "followers"),
    fetchFriendList(me.userId, "following"),
  ]);

  const followerSet = toSet(followers);
  const followingSet = toSet(following);

  // Normalize relationship flags for consistency
  followers.forEach((u) => {
    u.isFollowed = true; // they follow me
    u.isFollowing = followingSet.has(u.username); // I follow them
    u.isDeactivated = u.isDeactivated || false;
  });
  following.forEach((u) => {
    u.isFollowing = true; // I follow them
    u.isFollowed = followerSet.has(u.username); // they follow me
    u.isDeactivated = u.isDeactivated || false;
  });

  const dontFollowYouBack = setDiff(followingSet, followerSet);
  const youDontFollowBack = setDiff(followerSet, followingSet);
  const mutuals = setInter(followerSet, followingSet);

  const prev = await loadPreviousSnapshot();

  let peopleYouFollowed = [];
  let peopleYouUnfollowed = [];
  let newFollowers = [];
  let lostFollowers = [];

  if (prev.current) {
    const { prevFollowers, prevFollowing } = processPreviousData(prev);
    peopleYouFollowed = setDiff(followingSet, prevFollowing);
    peopleYouUnfollowed = setDiff(prevFollowing, followingSet);
    newFollowers = setDiff(followerSet, prevFollowers);
    lostFollowers = setDiff(prevFollowers, followerSet);
  }

  const snapshot = {
    username: me.username,
    userId: me.userId,
    ts: Date.now(),
    followers,
    following,
    peopleYouFollowed,
    peopleYouUnfollowed,
    newFollowers,
    lostFollowers,
  };
  await saveSnapshot(snapshot);

  return {
    me,
    dontFollowYouBack,
    youDontFollowBack,
    mutuals,
    peopleYouFollowed,
    peopleYouUnfollowed,
    newFollowers,
    lostFollowers,
    hasPrev: !!prev.current,
    cachedSnapshot: snapshot,
    previousSnapshot: prev.current || null,
    followers,
    following,
  };
}

async function scanFollowersAndFollowing() {
  const me = await getCurrentUser();
  const [followers, following] = await Promise.all([
    fetchFriendList(me.userId, "followers"),
    fetchFriendList(me.userId, "following"),
  ]);

  const followerSet = toSet(followers);
  const followingSet = toSet(following);

  const dontFollowYouBack = setDiff(followingSet, followerSet);
  const youDontFollowBack = setDiff(followerSet, followingSet);
  const mutuals = setInter(followerSet, followingSet);

  console.group("Instafn: Follow analysis");
  logSection("People who don't follow you back", dontFollowYouBack);
  logSection("People you don't follow back", youDontFollowBack);
  logSection("Mutual followers", mutuals);
  console.groupEnd();
}

function setDiff(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out.sort();
}

function setInter(a, b) {
  const out = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out.sort();
}

function logSection(title, items) {
  console.groupCollapsed(`${title} (${items.length})`);
  for (const it of items) console.log(it);
  console.groupEnd();
}


module.exports.fetchUserInfo = fetchUserInfo;
module.exports.updateFriendship = updateFriendship;
module.exports.getCurrentUser = getCurrentUser;
module.exports.getProfileUsernameFromPath = getProfileUsernameFromPath;
module.exports.getMeCached = getMeCached;
module.exports.isOwnProfile = isOwnProfile;
module.exports.fetchFriendList = fetchFriendList;
module.exports.extractUsernames = extractUsernames;
module.exports.getProfilePicData = getProfilePicData;
module.exports.loadPreviousSnapshot = loadPreviousSnapshot;
module.exports.saveSnapshot = saveSnapshot;
module.exports.computeFollowAnalysis = computeFollowAnalysis;
module.exports.scanFollowersAndFollowing = scanFollowersAndFollowing;
});


defineModule("features/follow-analyzer/ui.js", function (module, exports, require) {
var { loadPreviousSnapshot, extractUsernames, computeFollowAnalysis, getProfilePicData, fetchUserInfo, updateFriendship, getMeCached, isOwnProfile, getProfileUsernameFromPath } = require("features/follow-analyzer/logic.js");
var { injectStylesheet } = require("utils/styleLoader.js");
var { createModal, confirmModal } = require("ui/modal.js");
var { findReferenceButton } = require("features/follow-analyzer/find-reference-button.js");

const ensureStyles = () =>
  injectStylesheet(
    "content/features/follow-analyzer/follow-analyzer.css",
    "instafn-follow-analyzer"
  );

const INLINE_SCAN_BUTTON_SELECTOR = ".instafn-scan-btn:not(.instafn-scan-fab)";
const SCAN_BUTTON_ID = "instafn-scan-button";

let currentUsername = null;
let isInjecting = false;
let retryCount = 0;
// Retries are frame-tight (requestAnimationFrame, ~16ms) rather than every
// 500ms, so when Instagram paints its profile buttons incrementally and the
// first injection attempt misses the reference, we recover within a frame or
// two — before the late insertion is perceptible — instead of popping in half a
// second later and shifting the button row. ~90 frames ≈ 1.5s covers a slow
// header render; the always-on observer remains the primary, immediate path.
const MAX_RETRIES = 90;

/**
 * Check if we're on the user's own profile by looking for "Edit profile" or "View archive" buttons
 * This is synchronous and doesn't require async API calls
 */
function isOwnProfileSync() {
  const buttonTexts = ["Edit profile", "Edit Profile", "View archive"];
  const allButtons = Array.from(
    document.querySelectorAll("button, [role='button'], a[role='link']")
  );

  return buttonTexts.some((buttonText) => {
    return allButtons.some((el) => {
      const text = el.textContent?.trim();
      return text === buttonText;
    });
  });
}

/**
 * Create the Follow Analyzer button wrapper
 * Clones the structure of a reference button to match Instagram's styling
 */
function createScanButtonWrapper(referenceWrapper) {
  // Clone the reference wrapper's structure
  const buttonWrapper = document.createElement("div");
  buttonWrapper.className = referenceWrapper?.className || "html-div";
  buttonWrapper.id = SCAN_BUTTON_ID;

  // Create the button element - match Instagram's button structure
  const button = document.createElement("div");
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("aria-label", "Analyze");
  button.style.cursor = "pointer";
  button.className = "instafn-scan-btn";
  button.innerHTML = `
    <div class="_ap3a _aaco _aacw _aad6 _aade" dir="auto">Analyze</div>
  `;

  buttonWrapper.appendChild(button);
  return buttonWrapper;
}

function createFollowButton(
  username,
  isFollowing,
  cachedUserData = null
) {
  ensureStyles();
  const btn = document.createElement("button");
  btn.className = `instafn-follow-btn ${isFollowing ? "following" : ""}`;
  btn.textContent = isFollowing ? "Following" : "Follow";
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const originalText = btn.textContent;
    try {
      const userInfo = cachedUserData || (await fetchUserInfo(username));
      if (!userInfo) {
        btn.disabled = false;
        return;
      }
      const action = isFollowing ? "unfollow" : "follow";
      if (!confirm(`Do you want to ${action} @${username}?`)) {
        btn.disabled = false;
        return;
      }
      const userId = userInfo.id || userInfo.pk;
      if (!userId) {
        alert("Could not get user ID for this action");
        btn.disabled = false;
        return;
      }
      await updateFriendship(userId, !isFollowing);
      btn.classList.toggle("following");
      btn.textContent = btn.classList.contains("following")
        ? "Following"
        : "Follow";
    } catch (err) {
      alert(
        `Failed to ${isFollowing ? "unfollow" : "follow"} @${username}: ${
          err.message
        }`
      );
      btn.classList.toggle("following", isFollowing);
      btn.textContent = originalText;
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

let scanBtnObserver = null;

// Inject the button's *layout-critical* CSS synchronously (inline <style>), well
// before follow-analyzer.css — which injectStylesheet() loads as an async
// <link> — has a chance to arrive. Without this, the scan button's wrapper is
// inserted into the button row while its sizing rules (height, padding, the
// `flex: 1` on the .html-div slot) are still missing, so the slot has ~zero
// width until the stylesheet loads and then the whole row reflows: the late
// "pop-in" layout shift on load. Inlining geometry here reserves the correct
// slot the instant the wrapper is injected; the async stylesheet then only
// layers on colors/hover, which don't move anything. Keep this in sync with the
// matching selectors in follow-analyzer.css.
function injectCriticalLayoutCSS() {
  if (document.getElementById("instafn-follow-analyzer-early")) return;
  const style = document.createElement("style");
  style.id = "instafn-follow-analyzer-early";
  style.textContent = `
    .instafn-button-container {
      display: flex !important;
      gap: 12px !important;
      justify-content: center !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      min-height: 44px !important;
      contain: layout !important;
    }
    .instafn-button-container > .html-div {
      flex: 1 1 0% !important;
      display: flex !important;
      min-width: 0 !important;
    }
    .instafn-scan-btn {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      height: 44px !important;
      min-height: 0 !important;
      width: 100% !important;
      padding: 0 20px !important;
      margin: 0 !important;
      border: none !important;
      border-radius: 12px !important;
      box-sizing: border-box !important;
      flex-shrink: 0 !important;
      white-space: nowrap !important;
      font-size: 0.875rem !important;
      font-weight: var(--font-weight-system-semibold) !important;
      font-family: var(--font-family-system) !important;
      line-height: var(--system-14-line-height) !important;
      background-color: rgb(var(--ig-colors-button-secondary-background)) !important;
      color: rgb(var(--ig-colors-button-secondary-text)) !important;
      cursor: pointer !important;
      user-select: none !important;
    }
  `;
  const target = document.head || document.documentElement || document.body;
  if (target) {
    target.appendChild(style);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => target?.appendChild(style),
      { once: true }
    );
  }
}

let isEnabled = false;

/**
 * Inject the Follow Analyzer button
 * Only works on own profile (when "Edit profile" or "View archive" buttons are present)
 */
function injectScanButton() {
  if (!isEnabled) return;
  // Reserve the button's geometry synchronously before the async stylesheet
  // arrives, in case this runs before initFollowAnalyzerEarly() (both are gated
  // behind async storage reads, so their order isn't guaranteed). Idempotent.
  injectCriticalLayoutCSS();
  ensureStyles();
  if (isInjecting) return;

  // Only inject on own profile by looking for "Edit profile" or "View archive" buttons
  if (!isOwnProfileSync()) {
    removeScanButton();
    retryCount = 0;
    return;
  }

  const username = getProfileUsernameFromPath();
  if (!username) {
    const existing = document.getElementById(SCAN_BUTTON_ID);
    if (existing) existing.remove();
    currentUsername = null;
    retryCount = 0;
    return;
  }

  // Check if button already exists for this profile
  const existing = document.getElementById(SCAN_BUTTON_ID);
  if (existing && currentUsername === username) {
    return; // Already injected for this profile
  }

  // Remove button if it's for a different profile
  if (existing && currentUsername !== username) {
    existing.remove();
  }

  currentUsername = username;

  // Find reference button (Edit profile or View archive)
  const reference = findReferenceButton();
  if (!reference) {
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      requestAnimationFrame(() => injectScanButton());
    } else {
      console.warn(
        "[Instafn Follow Analyzer] Max retries reached, giving up on button injection"
      );
      retryCount = 0;
    }
    return;
  }

  // Check if button already exists in this container
  if (reference.container.querySelector(`#${SCAN_BUTTON_ID}`)) {
    retryCount = 0;
    return;
  }

  isInjecting = true;
  try {
    // Add instafn-button-container class to ensure equal flex distribution
    reference.container.classList.add("instafn-button-container");

    // Create button wrapper matching the reference wrapper's style
    const buttonWrapper = createScanButtonWrapper(reference.wrapper);

    // Attach click handler
    const button = buttonWrapper.querySelector('[role="button"]');
    if (button) {
      button.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const overlay = await openModal("Follow analysis");
          await renderScanButton(
            overlay.querySelector(".instafn-content"),
            overlay
          );
        } catch (err) {
          alert("Failed to open modal: " + (err?.message || String(err)));
        }
      });
    }

    // Insert after the reference wrapper (e.g. the Edit profile button)
    const insertAfter = reference.wrapper;
    if (insertAfter.nextSibling) {
      reference.container.insertBefore(buttonWrapper, insertAfter.nextSibling);
    } else {
      reference.container.appendChild(buttonWrapper);
    }

    console.log("[Instafn Follow Analyzer] Button injected successfully");
    retryCount = 0;
  } finally {
    isInjecting = false;
  }
}

function setScanButtonEnabled(enabled) {
  isEnabled = enabled;
  if (!enabled) {
    removeScanButton();
    currentUsername = null;
    retryCount = 0;
  }
}

/**
 * Set up DOM observer to watch for button container changes
 * Should be called once during initialization
 */
function setupScanButtonObserver() {
  if (scanBtnObserver) return; // Already set up

  scanBtnObserver = new MutationObserver(() => {
    // Only inject on own profile
    if (!isOwnProfileSync()) {
      removeScanButton();
      return;
    }
    const username = getProfileUsernameFromPath();
    if (username && !document.getElementById(SCAN_BUTTON_ID)) {
      // Button doesn't exist but we're on own profile - try to inject
      injectScanButton();
    }
  });
  scanBtnObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function removeScanButton() {
  const existing = document.getElementById(SCAN_BUTTON_ID);
  if (existing) existing.remove();
  // Also remove any FAB buttons
  document.querySelectorAll(".instafn-scan-fab").forEach((el) => el.remove());
  currentUsername = null;
  retryCount = 0;
  if (scanBtnObserver) {
    scanBtnObserver.disconnect();
    scanBtnObserver = null;
  }
}

function resetRetryCount() {
  retryCount = 0;
}

function getCurrentUsername() {
  return currentUsername;
}

function initFollowAnalyzerEarly() {
  injectCriticalLayoutCSS();
}

async function openModal(titleText) {
  ensureStyles();
  const overlay = await createModal(titleText || "Follow analyzer", {
    showTabs: true,
  });
  overlay.querySelector(".instafn-content").innerHTML =
    '<div class="instafn-empty">Preparing analysis...</div>';
  return overlay;
}

function confirmWithModal({
  title = "Confirm",
  message = "Are you sure?",
  confirmText = "Confirm",
  cancelText = "Cancel",
} = {}) {
  ensureStyles();
  return confirmModal({ title, message, confirmText, cancelText });
}

async function renderScanButton(content, overlay) {
  ensureStyles();
  const prevData = await loadPreviousSnapshot();
  const hasPreviousScan =
    prevData.current?.username &&
    prevData.current?.followers &&
    prevData.current?.following;

  content.innerHTML = `
    <div style="text-align: center; padding: 40px 20px; padding-top: 30px">
      <p class="instafn-modal-description">
        ${
          hasPreviousScan
            ? 'This will update your follow analysis, populating any "Since last:" tabs if applicable.<br/><br/><strong>Try not to use this more than once a day. Instafn is not liable for any rate limiting or account bans. Do not use this if you have a combined following and follower count of ≥13,000. USE AT YOUR OWN RISK!</strong>'
            : "This analyzes your followers and following to show who doesn't follow you back, who you don't follow back, mutual followers, and changes since your last scan.<br/><br/><strong>Try not to use this more than once a day. Do not use this if you have a combined following and follower count of ≥13,000. Instafn is not liable for account bans. USE AT YOUR OWN RISK!</strong>"
        }
      </p>
      <div class="instafn-button-container">
        ${
          hasPreviousScan
            ? `<button id="instafn-view-previous" class="instafn-secondary-button">View Last Scan</button>`
            : ""
        }
        <button id="instafn-start-scan" class="instafn-primary-button">${
          hasPreviousScan ? "New Scan" : "Start Scan"
        }</button>
      </div>
    </div>
  `;

  const scanBtn = content.querySelector("#instafn-start-scan");
  const viewPreviousBtn = content.querySelector("#instafn-view-previous");

  if (viewPreviousBtn) {
    viewPreviousBtn.addEventListener("click", async () => {
      const titleEl = overlay.querySelector(".instafn-modal-title");
      const scanDate = new Date(prevData.current.ts).toLocaleDateString();
      titleEl.textContent = `Previous Results for @${prevData.current.username} (${scanDate})`;
      const followerSet = new Set(
        extractUsernames(prevData.current.followers || [])
      );
      const followingSet = new Set(
        extractUsernames(prevData.current.following || [])
      );
      const mockData = {
        me: {
          username: prevData.current.username,
          userId: prevData.current.userId,
        },
        dontFollowYouBack: Array.from(followingSet).filter(
          (u) => !followerSet.has(u)
        ),
        youDontFollowBack: Array.from(followerSet).filter(
          (u) => !followingSet.has(u)
        ),
        mutuals: Array.from(followerSet).filter((u) => followingSet.has(u)),
        peopleYouFollowed: prevData.current.peopleYouFollowed || [],
        peopleYouUnfollowed: prevData.current.peopleYouUnfollowed || [],
        newFollowers: prevData.current.newFollowers || [],
        lostFollowers: prevData.current.lostFollowers || [],
        hasPrev: true,
        cachedSnapshot: prevData.current,
        previousSnapshot: prevData.previous || prevData.current || null,
        followers: prevData.current.followers || [],
        following: prevData.current.following || [],
      };
      await renderAnalysisInto(content, mockData);
    });
  }

  scanBtn.addEventListener("click", async () => {
    try {
      overlay.querySelector(".instafn-modal-title").textContent = "Scanning...";
      content.innerHTML = `
        <div class="instafn-loading-container">
          <div class="instafn-loading-spinner"></div>
          <p class="instafn-loading-text">Scanning followers and following...</p>
        </div>
      `;
      const data = await computeFollowAnalysis();
      await renderAnalysisInto(content, data);
    } catch (err) {
      const isRateLimited = /429|Rate limited/i.test(err?.message || "");
      content.innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
          <div class="instafn-error-icon">⚠️</div>
          <h3 class="instafn-error-title">${
            isRateLimited ? "Rate Limited" : "Scan Failed"
          }</h3>
          <p class="instafn-error-message">${
            isRateLimited
              ? "Instagram is rate limiting requests right now. Please try again in 15–60 minutes and avoid running scans repeatedly."
              : err.message
          }</p>
          ${
            isRateLimited
              ? '<div class="instafn-error-hint">Tips: keep one Instagram tab open, disable ad blockers for instagram.com, and wait before retrying.</div>'
              : ""
          }
          <button onclick="this.closest('.instafn-modal-overlay').remove()" class="instafn-primary-button">Close</button>
        </div>
      `;
    }
  });
}

async function getUserInfo(
  username,
  data,
  currentFollowerSet,
  currentFollowingSet,
  prevFollowerSet,
  prevFollowingSet
) {
  let cachedData =
    getProfilePicData(username, data.cachedSnapshot) ||
    getProfilePicData(username, data.previousSnapshot);
  if (!cachedData) {
    cachedData =
      data.followers?.find((u) => u.username === username) ||
      data.following?.find((u) => u.username === username);
  }

  let info =
    cachedData &&
    (cachedData.profilePicBase64 ||
      cachedData.profilePicUrl ||
      cachedData.profilePic ||
      cachedData.isDeactivated !== undefined)
      ? {
          username: cachedData.username,
          fullName: cachedData.fullName || username,
          profilePic:
            cachedData.profilePicBase64 ||
            cachedData.profilePic ||
            cachedData.profilePicUrl ||
            null,
          isPrivate: cachedData.isPrivate || false,
          isVerified: cachedData.isVerified || false,
          isFollowed: !!cachedData.isFollowed,
          isFollowing: !!cachedData.isFollowing,
          id: cachedData.id,
          isDeactivated: !!cachedData.isDeactivated,
        }
      : null;

  const shouldProbe = !info || (!info.profilePic && !info.isDeactivated);
  if (shouldProbe) {
    try {
      const fetched = await fetchUserInfo(username);
      if (fetched) {
        info = {
          username: fetched.username,
          fullName: fetched.fullName || username,
          profilePic: fetched.profilePic || info?.profilePic || null,
          isPrivate: fetched.isPrivate ?? info?.isPrivate ?? false,
          isVerified: fetched.isVerified ?? info?.isVerified ?? false,
          isFollowed:
            fetched.isFollowed ??
            info?.isFollowed ??
            currentFollowerSet.has(username),
          isFollowing:
            fetched.isFollowing ??
            info?.isFollowing ??
            currentFollowingSet.has(username),
          id: fetched.id || info?.id || null,
          isDeactivated: !!fetched.isDeactivated,
        };
      }
    } catch (_) {}
  }

  if (!info) {
    info = {
      username,
      fullName: username,
      profilePic: null,
      isPrivate: false,
      isVerified: false,
      isFollowed:
        currentFollowerSet.has(username) || prevFollowerSet.has(username),
      isFollowing:
        currentFollowingSet.has(username) || prevFollowingSet.has(username),
      id: null,
      isDeactivated: false,
    };
  }

  info.isFollowed =
    info.isFollowed ||
    currentFollowerSet.has(username) ||
    prevFollowerSet.has(username) ||
    false;
  info.isFollowing =
    info.isFollowing ||
    currentFollowingSet.has(username) ||
    prevFollowingSet.has(username) ||
    false;
  return info;
}

function createUserItem(username, info, itemIsFollowing) {
  const item = document.createElement("div");
  item.className = "instafn-item";
  const itemLeft = document.createElement("div");
  itemLeft.className = "instafn-item-left";
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src =
    info?.profilePic ||
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAUGBgsICwsLCwsNCwsLDQ4ODQ0ODg8NDg4ODQ8QEBARERAQEBAPExITDxARExQUExETFhYWExYVFRYZFhkWFhIBBQUFCgcKCAkJCAsICggLCgoJCQoKDAkKCQoJDA0LCgsLCgsNDAsLCAsLDAwMDQ0MDA0KCwoNDA0NDBMUExMTnP/AABEIAJYAlgMBIgACEQEDEQH/xABcAAEAAQUBAQAAAAAAAAAAAAAAAwECBAcIBgUQAAIBAgIECgUGDwAAAAAAAAABAgMEBREGITFBEhMiMkJRYXGRoSNTYnKBFFKCorHBBxckMzRDVGODkqPC0eLw/9oADAMBAAIAAwAAPwDrsAFxaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWTnGCzlJRXXJqK8WYiv7dvLj6WfVxkP8gGcC1NSWaea61rXiXAAAAAAAAAAAAAAAAAAAAAAEVWrGlGU5yUIRWcpSeSSW9s1LjOm85t07LkQ9dJcqXuxeqK7Xr7jA0wx53VV2tKXoKMuVl+sqLb9GOxdus1+Sxh1ljkZFxc1biXCq1J1JPfOTl9pjZLqRUEhaZ1piFe0lwqNadN+zJ5fFc1+BtHBNNVVcaV6owk9SrR1Qb9tdHvWruNQAtccyuZ1aVNWaF465/kVaWbSzoSfUtsPgtcfijaZC1kXpgAFCoAAAAAAAAAAAAPjY3e/I7O4rLnRg1H3pcmPm8z7J4fTeTWHvtrUs/FlVtRRmiQAZBGAAAAAAZFtcSt6lOrB5SpyU19F5nUFGqq0IVI82pGMl3SWZyudIaPScrC0z9THy1EdQuefeABEXgAAAAAAAAAAAA8tpVbO4w+4S1uCjUX8N5v6uZ6ktlFSTTWaaaa609pVA5TB93HMKlhtzOk+Y+VSl86D2fFbGfCJyIAAqAAACqTepbXs7zp7D7b5Nb0KPq6UIvvUVn5mltEMId5cqrJeht2pS6pT6Mf7n2I3wRVGXxAAIy4AAAAAAAAAAAAAAA+JjGD0sTo8VU1SWunUXOhL70963mhcUwa4w2fBrQ5PRqLXCfc+vses6VI6lKNSLhOKnGW2MkpJ/B6i6MsijWZyqDfV1oZYVnnGE6Lfq5av5ZcJHy1oDbZ/pFbLuh/gk4aLeCaZPT4Lo5cYlJNJ06GfKqyWr6C6T8utm2rPRKwtmpcU6slvqy4f1dUfI9YllqWpLYtiRRz6gomFY2NKypRo0Y8GEPFve297e9mcARF4AAAAAAAAAAAAAAABZOagnKTUYxWbbeSSW9s1pjGnEKedOziqkvWy5n0Y7Zd7yRVLMNmyqlWNOLlOUYRW2Umorxeo8rdaX4fQ1ca6rW6lFy+s8o+Zo28xCveS4derKo/aepd0eavgjBJFTLOEbgq/hAormWtSXvTjH7MzH/GCv2T+r/qanBXgIpwjc1HT62l+coVodzhP74npbPSSxuslC4jGT6NT0cvravM50A4BXhHVpU5uw3Hruwa4qq+B6ufLg/g9nwyNvYLpZb4hlTn6Cu+jJ8mfuS+56+8scMi5SPZgAsKgAAAAAAAAAx7i4p29OVWrJQpwWcpPcv8Ati3k5obSnH3iFXiqcvyak+T+8lvm+z5vZr3l0Y5lG8iHSDSSriUnCOdO2T5MN8/an19i2LvPIgExGAAVAAAAAAAAABtLRnS1xcba8knHZTrS2x9mb6uqW7ebcOUTb+hukDqpWVeWc4r0Mn0oroPtXR7NW4inEvizZ4AIy4AAAAAA8Fpni3yW3VCDyq3OaeW2NJc7+bm+Jo49HpJf/LL2tPPOEHxcPdp6vOWbPOE8VkRsAAuKAAAAAAAAAAAAAlpVZUpxnHCXBnBqUZLc1sIgAdL4RiMcQtqVdanJZTXzZx1SXjs7GfXNQaBX/AAala1b1TjxkPejql4xy8Db5BJZEiAALSoMK/r8Rb16i206U5LvUXl5gFUDl4AGQRAAAAAAAAAAAAAAAAAAH39Ha7o39rJetUX3T5L+06PAIqhfEAAjLj//Z";
  const itemInfo = document.createElement("div");
  itemInfo.className = "instafn-item-info";
  const usernameEl = document.createElement("div");
  usernameEl.className = "instafn-item-username";
  const usernameLink = document.createElement("a");
  usernameLink.href = `https://www.instagram.com/${username}/`;
  usernameLink.target = "_blank";
  usernameLink.rel = "noopener noreferrer";
  usernameLink.textContent = username;
  usernameEl.appendChild(usernameLink);
  if (info.isDeactivated) {
    const deactivatedTag = document.createElement("span");
    deactivatedTag.className = "instafn-deactivated-tag";
    deactivatedTag.title = "This account appears deactivated/unavailable.";
    deactivatedTag.textContent = "⚠️";
    usernameEl.appendChild(deactivatedTag);
  }
  const nameEl = document.createElement("div");
  nameEl.className = "instafn-item-name";
  nameEl.textContent = info?.fullName || "";
  itemInfo.appendChild(usernameEl);
  itemInfo.appendChild(nameEl);
  itemLeft.appendChild(img);
  itemLeft.appendChild(itemInfo);
  item.appendChild(itemLeft);
  item.appendChild(createFollowButton(username, itemIsFollowing, info));
  return item;
}

async function renderAnalysisInto(container, data) {
  ensureStyles();
  const currentFollowerSet = new Set(extractUsernames(data.followers || []));
  const currentFollowingSet = new Set(extractUsernames(data.following || []));
  const prevFollowerSet = new Set(
    extractUsernames(data.previousSnapshot?.followers || [])
  );
  const prevFollowingSet = new Set(
    extractUsernames(data.previousSnapshot?.following || [])
  );

  const tabDefs = [
    {
      key: "dontFollowYouBack",
      label: "Don't follow you back",
      isFollowing: true,
    },
    {
      key: "youDontFollowBack",
      label: "You don't follow back",
      isFollowing: false,
    },
    {
      key: "lostFollowers",
      label: "Since last: Unfollowed you",
      isFollowing: false,
    },
    {
      key: "newFollowers",
      label: "Since last: Followed you",
      isFollowing: false,
    },
    {
      key: "peopleYouFollowed",
      label: "Since last: You followed",
      isFollowing: true,
    },
    {
      key: "peopleYouUnfollowed",
      label: "Since last: You unfollowed",
      isFollowing: false,
    },
    { key: "mutuals", label: "Mutual followers", isFollowing: true },
  ];

  const modal = container.closest(".instafn-modal");
  const tabsBar = modal.querySelector(".instafn-tabs");
  tabsBar.innerHTML = "";
  const views = new Map();

  for (const def of tabDefs) {
    const items = data[def.key] || [];
    const btn = document.createElement("button");
    btn.className = "instafn-tab";
    btn.textContent = `${def.label} (${items.length})`;
    tabsBar.appendChild(btn);

    const view = document.createElement("div");
    view.style.display = "none";
    if (!items.length) {
      view.innerHTML = '<div class="instafn-empty">None</div>';
    } else {
      const list = document.createElement("div");
      list.className = "instafn-list";
      const userInfos = await Promise.all(
        items.map((username) =>
          getUserInfo(
            username,
            data,
            currentFollowerSet,
            currentFollowingSet,
            prevFollowerSet,
            prevFollowingSet
          )
        )
      );
      userInfos.forEach((info, i) => {
        list.appendChild(createUserItem(items[i], info, def.isFollowing));
      });
      view.appendChild(list);
    }
    views.set(btn, view);
  }

  function activate(btn) {
    for (const [b, v] of views.entries()) {
      b.classList.toggle("active", b === btn);
      v.style.display = b === btn ? "block" : "none";
    }
    const tabsBar = btn.closest(".instafn-tabs");
    if (tabsBar) {
      const btnRect = btn.getBoundingClientRect();
      const tabsBarRect = tabsBar.getBoundingClientRect();
      if (
        btnRect.left < tabsBarRect.left ||
        btnRect.right > tabsBarRect.right
      ) {
        btn.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      }
    }
    container.innerHTML = "";
    container.appendChild(views.get(btn));
  }

  for (const [btn] of views.entries())
    btn.addEventListener("click", () => activate(btn));
  const firstBtn = tabsBar.querySelector(".instafn-tab");
  if (firstBtn) activate(firstBtn);
  const titleEl = modal.querySelector(".instafn-modal-title");
  if (!titleEl.textContent.includes("Previous Results")) {
    titleEl.textContent = `Follow analysis for @${data.me.username}`;
  }
}


module.exports.createFollowButton = createFollowButton;
module.exports.injectScanButton = injectScanButton;
module.exports.setScanButtonEnabled = setScanButtonEnabled;
module.exports.setupScanButtonObserver = setupScanButtonObserver;
module.exports.removeScanButton = removeScanButton;
module.exports.resetRetryCount = resetRetryCount;
module.exports.getCurrentUsername = getCurrentUsername;
module.exports.initFollowAnalyzerEarly = initFollowAnalyzerEarly;
module.exports.openModal = openModal;
module.exports.confirmWithModal = confirmWithModal;
module.exports.renderScanButton = renderScanButton;
module.exports.renderAnalysisInto = renderAnalysisInto;
});


defineModule("features/follow-analyzer/find-reference-button.js", function (module, exports, require) {
// Locates a known profile action button (e.g. "Edit profile", "Follow",
// "Message") and returns it along with its wrapper and flex container, so other
// buttons can be injected alongside it. Mirrors Instagram's nested ".html-div"
// layout on profile headers.

const REFERENCE_BUTTON_LABELS = [
  "Message",
  "Follow Back",
  "Follow",
  "Requested",
  "View archive",
  "Edit profile",
  "Edit Profile",
  "Following",
];

function findReferenceButton() {
  const header = document.querySelector("header");
  const sections = Array.from(document.querySelectorAll("section")).filter(
    (section) => {
      if (header && !header.contains(section)) {
        const headerRect = header.getBoundingClientRect();
        if (section.getBoundingClientRect().top > headerRect.bottom + 500) {
          return false;
        }
      }
      return !!section.querySelector("button, [role='button'], a[role='link']");
    }
  );

  const scopes = [];
  if (header) scopes.push(header);
  scopes.push(...sections);

  for (const label of REFERENCE_BUTTON_LABELS) {
    const matches = Array.from(
      document.querySelectorAll("button, [role='button'], a[role='link']")
    ).filter((el) => el.textContent?.trim() === label);
    if (matches.length === 0) continue;

    for (const button of matches) {
      const scope = scopes.find((s) => s.contains(button));
      if (!scope) continue;

      let wrapper = button.closest(".html-div");
      if (!wrapper) continue;

      let parent = wrapper.parentElement;
      let container = null;
      while (parent && parent !== document.body) {
        const htmlDivChildren = Array.from(parent.children || []).filter(
          (child) => child.classList && child.classList.contains("html-div")
        );
        if (htmlDivChildren.length >= 1 && scope.contains(parent)) {
          container = parent;
          // Walk the wrapper up so it is a direct child of the container.
          let candidate = wrapper;
          while (candidate && candidate.parentElement !== container) {
            const candidateParent = candidate.parentElement;
            if (
              candidateParent &&
              candidateParent.classList &&
              candidateParent.classList.contains("html-div")
            ) {
              candidate = candidateParent;
            } else {
              break;
            }
          }
          if (candidate && candidate.parentElement === container) {
            wrapper = candidate;
          }
          break;
        }
        parent = parent.parentElement;
      }

      if (container) return { button, wrapper, container };
    }
  }

  return null;
}


module.exports.findReferenceButton = findReferenceButton;
});


defineModule("features/dm-popup-hider/index.js", function (module, exports, require) {
// DM Popup Hider: Hide the floating DM menu that appears when clicking home from DMs
// Also blocks API calls that mark messages as read when not on DM page

let isEnabled = false;
let observer = null;
let debugMode = false; // Set to true to log DM-related requests for debugging

function hideDMPopup() {
  if (!isEnabled) return;

  // Check if we're on the main DM page - if so, don't hide anything
  const isOnDMPage = window.location.pathname.includes('/direct/');
  if (isOnDMPage) return;

  // Find the DM popup menu - it's a floating window with conversation content
  // Look for elements with aria-label containing "Conversation with" or similar DM indicators
  const dmPopups = document.querySelectorAll('div[aria-label*="Conversation"], div[aria-label*="conversation"]');
  
  dmPopups.forEach((popup) => {
    // Check if this is the floating DM popup (not the main DM page)
    // The popup has specific styling with width/height CSS variables
    const container = popup.closest('div[style*="--x-height"][style*="--x-width"]');
    if (container && !container.dataset.instafnDmPopupHidden) {
      // Hide the popup
      container.style.display = 'none';
      container.dataset.instafnDmPopupHidden = 'true';
    }
  });

  // Also look for the specific structure from the HTML provided
  // The popup has classes like x7r02ix and contains message content
  const potentialPopups = document.querySelectorAll('div.x7r02ix');
  potentialPopups.forEach((popup) => {
    // Skip if already hidden
    if (popup.dataset.instafnDmPopupHidden) return;
    
    // Check if it contains DM conversation elements
    const hasConversation = popup.querySelector('div[aria-label*="Conversation"]') ||
                           popup.querySelector('div[data-pagelet="IGDOpenMessageList"]') ||
                           popup.querySelector('div[aria-label*="Messages in conversation"]') ||
                           popup.querySelector('div[data-scope="messages_table"]');
    
    // Also check for the specific width/height styling that indicates it's a floating popup
    const hasPopupStyling = popup.style.getPropertyValue('--x-height') && 
                           popup.style.getPropertyValue('--x-width');
    
    if (hasConversation || hasPopupStyling) {
      popup.style.display = 'none';
      popup.dataset.instafnDmPopupHidden = 'true';
    }
  });

  // Hide the floating messages button/indicator that appears even when no DMs are loaded
  // This is the button with aria-label containing "Messages" and notification count
  // Look for buttons with aria-label like "Messages - X new notifications"
  const messagesButtons = document.querySelectorAll('button[aria-label*="Messages"], div[aria-label*="Messages"][role="button"]');
  messagesButtons.forEach((button) => {
    if (button.dataset.instafnDmPopupHidden) return;
    
    // Check if it's the floating messages button (has notification badge, user avatars, or messages icon)
    const hasNotificationBadge = button.querySelector('span[class*="xwmz7sl"], span[class*="x1gabggj"], div[class*="x4fivb0"]');
    const hasUserAvatars = button.querySelector('img[alt="User avatar"]');
    const hasMessagesIcon = button.querySelector('svg[aria-label="Messages"]');
    const hasMessagesText = Array.from(button.querySelectorAll('span')).some(span => span.textContent?.trim() === 'Messages');
    
    // Check if it's in a floating container or has the floating button class
    const container = button.closest('div.x3h4tne, div.x145d82y, div.xixxii4');
    const isFloatingButton = button.classList.contains('x7r02ix') || 
                            (container && (container.classList.contains('x3h4tne') || container.classList.contains('x145d82y') || container.classList.contains('xixxii4')));
    
    if ((hasNotificationBadge || hasUserAvatars || hasMessagesIcon || hasMessagesText) && isFloatingButton) {
      // Hide the container if it exists, otherwise hide the button
      if (container && !container.dataset.instafnDmPopupHidden) {
        container.style.display = 'none';
        container.dataset.instafnDmPopupHidden = 'true';
      } else if (!button.dataset.instafnDmPopupHidden) {
        button.style.display = 'none';
        button.dataset.instafnDmPopupHidden = 'true';
      }
    }
  });

  // Also look for the container div with classes x3h4tne x145d82y xixxii4 (the outer container)
  const floatingMessageContainers = document.querySelectorAll('div.x3h4tne.x145d82y.xixxii4');
  floatingMessageContainers.forEach((container) => {
    if (container.dataset.instafnDmPopupHidden) return;
    
    // Check if it contains messages-related content
    const hasMessagesContent = container.querySelector('button[aria-label*="Messages"]') ||
                               container.querySelector('svg[aria-label="Messages"]') ||
                               Array.from(container.querySelectorAll('span')).some(span => span.textContent?.trim() === 'Messages');
    
    if (hasMessagesContent) {
      container.style.display = 'none';
      container.dataset.instafnDmPopupHidden = 'true';
    }
  });
}

function startObserver() {
  if (observer) return;
  
  observer = new MutationObserver(() => {
    hideDMPopup();
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

let lastUrl = location.href;
let originalFetch = null;
let originalXHRSend = null;
let originalXHROpen = null;

// Debug helper to log DM-related requests
function logDMRequest(type, url, body, method = 'POST') {
  if (!debugMode) return;
  
  const isDMRelated = 
    (url && (url.includes('/direct/') || url.includes('direct') || url.includes('message') || url.includes('chat'))) ||
    (body && typeof body === 'string' && (
      body.includes('direct') || 
      body.includes('message') || 
      body.includes('chat') ||
      body.includes('read') ||
      body.includes('seen') ||
      body.includes('thread') ||
      body.includes('inbox')
    ));
  
  if (isDMRelated) {
    console.log(`[Instafn DM Debug] ${type} Request:`, {
      method,
      url: url || 'N/A',
      body: body ? (body.length > 500 ? body.substring(0, 500) + '...' : body) : 'N/A',
      timestamp: new Date().toISOString(),
      pathname: window.location.pathname
    });
  }
}

// Block DM read/seen API calls when not on DM page
function shouldBlockDMRequest(url, body) {
  if (!isEnabled) return false;
  
  // Don't block if we're on the DM page
  const isOnDMPage = window.location.pathname.includes('/direct/');
  if (isOnDMPage) return false;
  
  // Check URL patterns
  if (url) {
    const urlStr = url.toString();
    if (
      urlStr.includes('/direct/') ||
      urlStr.includes('direct_inbox') ||
      urlStr.includes('direct_v2') ||
      urlStr.includes('ig_direct') ||
      urlStr.includes('threads') ||
      (urlStr.includes('graphql') && (urlStr.includes('direct') || urlStr.includes('message')))
    ) {
      // Check if it's a read/seen request
      if (body && typeof body === 'string') {
        const bodyLower = body.toLowerCase();
        if (
          bodyLower.includes('mark_as_read') ||
          bodyLower.includes('markasread') ||
          bodyLower.includes('seen') ||
          bodyLower.includes('read_receipt') ||
          bodyLower.includes('readreceipt') ||
          bodyLower.includes('thread_id') ||
          bodyLower.includes('threadid')
        ) {
          return true;
        }
      } else {
        // If no body but URL suggests DM read operation, block it
        if (urlStr.includes('read') || urlStr.includes('seen')) {
          return true;
        }
      }
    }
  }
  
  // Check body patterns
  if (body && typeof body === 'string') {
    const bodyLower = body.toLowerCase();
    if (
      bodyLower.includes('mark_as_read') ||
      bodyLower.includes('markasread') ||
      bodyLower.includes('read_receipt') ||
      bodyLower.includes('readreceipt') ||
      (bodyLower.includes('direct') && (bodyLower.includes('read') || bodyLower.includes('seen')))
    ) {
      return true;
    }
  }
  
  return false;
}

function initDMPopupHider(settings) {
  isEnabled = settings.hideDMPopup;
  debugMode = settings.debugDMPopup || false; // Add this to settings if needed
  
  if (isEnabled) {
    // Hide existing popups immediately
    if (document.body) {
      hideDMPopup();
    }
    
    // Also hide after a short delay to catch dynamically loaded popups
    setTimeout(() => {
      hideDMPopup();
    }, 500);
    
    // Start observing for new popups
    if (document.body) {
      startObserver();
    } else {
      // Wait for body to be ready
      const bodyObserver = new MutationObserver(() => {
        if (document.body) {
          hideDMPopup();
          startObserver();
          bodyObserver.disconnect();
        }
      });
      bodyObserver.observe(document.documentElement, { childList: true });
    }
    
    // Watch for URL changes (e.g., navigating from DMs to home)
    const urlObserver = new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        // Hide popup when URL changes (especially when leaving DMs)
        setTimeout(() => {
          hideDMPopup();
        }, 100);
      }
    });
    urlObserver.observe(document, { subtree: true, childList: true });
    
    // Intercept and block DM read/seen API calls
    if (!originalFetch) {
      originalFetch = window.fetch;
      window.fetch = function(...args) {
        const [url, options = {}] = args;
        const body = options.body || '';
        const method = options.method || 'GET';
        
        logDMRequest('FETCH', url, typeof body === 'string' ? body : body.toString(), method);
        
        if (shouldBlockDMRequest(url, typeof body === 'string' ? body : body.toString())) {
          console.log('[Instafn] Blocked DM read/seen request via fetch:', url);
          // Return a resolved promise with empty response to prevent errors
          return Promise.resolve(new Response(null, { status: 200, statusText: 'OK' }));
        }
        
        return originalFetch.apply(this, args);
      };
    }
    
    if (!originalXHROpen) {
      originalXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._instafnDmUrl = url;
        this._instafnDmMethod = method;
        return originalXHROpen.apply(this, [method, url, ...rest]);
      };
    }
    
    if (!originalXHRSend) {
      originalXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(body) {
        const url = this._instafnDmUrl;
        const method = this._instafnDmMethod || 'GET';
        const bodyStr = body ? (typeof body === 'string' ? body : body.toString()) : '';
        
        logDMRequest('XHR', url, bodyStr, method);
        
        if (shouldBlockDMRequest(url, bodyStr)) {
          console.log('[Instafn] Blocked DM read/seen request via XHR:', url);
          // Don't send the request
          return;
        }
        
        return originalXHRSend.apply(this, [body]);
      };
    }
  } else {
    // Re-show any hidden popups if feature is disabled
    document.querySelectorAll('[data-instafn-dm-popup-hidden="true"]').forEach((el) => {
      el.style.display = '';
      delete el.dataset.instafnDmPopupHidden;
    });
    stopObserver();
    
    // Restore original fetch/XHR if they were intercepted
    if (originalFetch) {
      window.fetch = originalFetch;
      originalFetch = null;
    }
    if (originalXHROpen) {
      XMLHttpRequest.prototype.open = originalXHROpen;
      originalXHROpen = null;
    }
    if (originalXHRSend) {
      XMLHttpRequest.prototype.send = originalXHRSend;
      originalXHRSend = null;
    }
  }
}

// Export debug function to enable from console
function enableDMDebug() {
  debugMode = true;
  console.log('[Instafn] DM request debugging enabled. Check console for DM-related network requests.');
  console.log('[Instafn] Navigate to home page and watch for DM read/seen requests.');
  console.log('[Instafn] Look for requests with patterns like: mark_as_read, read_receipt, seen, etc.');
}



module.exports.initDMPopupHider = initDMPopupHider;
module.exports.enableDMDebug = enableDMDebug;
});


defineModule("features/message-double-tap-like/index.js", function (module, exports, require) {
/**
 * Message Double-Tap to Like Feature
 *
 * Double-click a message bubble to react with the heart (first reaction).
 * Works by hovering the message, clicking the React button, then the ❤️ — all
 * instantly and without any visible flash of the hover bar or reaction panel.
 *
 * Instagram's DM DOM changed: messages are now `[role="group"][tabindex="-1"]`
 * with `[role="presentation"]` bubbles (no more "Double tap to like" buttons),
 * so detection lives in the shared module.
 */

var { showToast } = require("ui/toast.js");
var { MESSAGE_GROUP_SELECTOR, reactToMessage } = require("features/_shared/dm-message-actions.js");

const STYLE_ID = "instafn-double-tap-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Stop the browser selecting text when the user double-clicks a bubble.
  style.textContent = `${MESSAGE_GROUP_SELECTOR}{ -webkit-user-select:none; user-select:none; }`;
  document.head.appendChild(style);
}

function findMessageGroup(target) {
  const group = target.closest?.(MESSAGE_GROUP_SELECTOR);
  if (!group) return null;
  // Ignore clicks on the hover action bar / avatar links themselves.
  if (target.closest('[role="dialog"], a[role="link"]')) return null;
  return group;
}

const DOUBLE_TAP_MS = 350;

function initMessageDoubleTapLike() {
  ensureStyle();

  // Detect the double-tap manually via click timing instead of the native
  // `dblclick` event. The first click renders the hover bar (shifting layout)
  // and can begin a text selection, so the second click often lands on a
  // different target — which suppresses native `dblclick` entirely. Matching on
  // the message GROUP (not the exact element) is robust to that.
  let lastTapTime = 0;
  let lastTapGroup = null;

  // Prevent text selection from the second click of a double-tap.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.detail > 1 && findMessageGroup(e.target)) {
        e.preventDefault();
      }
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted) return;
      const group = findMessageGroup(e.target);
      if (!group) {
        lastTapTime = 0;
        lastTapGroup = null;
        return;
      }

      const now = Date.now();
      if (lastTapGroup === group && now - lastTapTime < DOUBLE_TAP_MS) {
        e.preventDefault();
        e.stopPropagation();
        lastTapTime = 0;
        lastTapGroup = null;

        reactToMessage(group).then((ok) => {
          if (!ok) showToast("Couldn't like message");
        });
      } else {
        lastTapTime = now;
        lastTapGroup = group;
      }
    },
    true
  );
}


module.exports.initMessageDoubleTapLike = initMessageDoubleTapLike;
});


defineModule("features/dm-theme-debug/index.js", function (module, exports, require) {
// DM Background + bubble/reaction theming
//
// IG web never applies chat themes; we render them from the private mobile API
// (the only place the theme lives on web).
//
//   GET /api/v1/direct_v2/threads/{canonicalId}/  -> thread.theme_data
// theme_data ships BOTH colour modes:
//   - top level         = light / "NORMAL" (app_color_mode:"NORMAL")
//   - alternative_themes = the other mode(s), e.g. app_color_mode:"DARK"
// Each variant has: gradient_colors (outgoing bubble), incoming_message_bubble_color,
// thread_background_color + thread_background_asset (the real background image),
// inbound/outbound_message_text_color, reaction_pill_color, emphasized_action_color.
// We pick the variant matching IG's current mode (its own __fb-dark-mode toggle).
//
// The `/direct/t/<id>` URL id is a thread_key (REST 500s); we resolve the
// canonical id via the inbox once and cache it.
//
// Network discipline (privacy/efficiency): the theme is cached PER CHAT
// (themeCache, keyed by canonicalId, TTL 10 min). Switching between chats, the
// keep-alive poll, focus and dark/light flips all read the cache and do NOT ping
// IG. We only hit the network on a cache miss (first view of a chat), a TTL
// expiry, or a detected live theme change ("changed the theme to" admin message,
// which forces a refetch). Unresolved chats are negatively cached for 60s so the
// inbox isn't re-pinged every poll.

const IG_APP_ID = "936619743392459";
const DEFAULT_THEME_ID = "3259963564026002";
const STYLE_ID = "instafn-dm-theme-style";
const THREADLIST_STYLE_ID = "instafn-dm-threadlist-style";
const STATUS_ID = "instafn-dm-theme-status"; // header spinner / error indicator

let themeStatusState = "idle"; // "idle" | "loading" | "error"
let themeStatusError = "";
const BG_FLAG = "instafnDmBg";
const POLL_MS = 8000;
const OUTGOING_BUBBLE_SELECTOR = ".x5slmwz"; // IG outgoing (sent) bubble bg class

// CSS custom properties we set on the pane (so cleanup is exhaustive).
const THEME_VARS = [
  "--mwp-message-row-background",
  "--mwp-primary-theme-color",
  "--ig-incoming-message-bubble",
  "--ig-outgoing-message-bubble",
  "--chat-incoming-message-bubble-background-color",
  "--chat-outgoing-message-bubble-background-color",
  "--mwp-header-background-color",
  "--chat-composer-background-color",
  "--chat-composer-input-background-color",
];
const INCOMING_BUBBLE_SELECTOR = ".x88qbow"; // IG incoming bubble bg class
const PANE_FLAG = "instafnDmPane";

let navObserver = null;
let htmlObserver = null;
let pollTimer = null;
let currentUrlId = null;
let lastAppliedKey = null;
let resolving = false;
let lastDark = null;
const canonicalByUrlId = new Map();
// Per-chat theme cache so switching chats / polling / focus does NOT re-ping IG.
// canonicalId -> { theme, ts }. Only a cache miss, a TTL expiry, or a detected
// live theme change actually hits the network.
const themeCache = new Map();
const THEME_TTL_MS = 10 * 60 * 1000; // refetch a given chat's theme at most once / 10 min
// Negative cache for canonical-id resolution so we don't re-ping the inbox every
// poll for a chat that didn't resolve.
const canonicalMissAt = new Map();
const CANONICAL_MISS_TTL_MS = 60 * 1000;
// After a failed fetch, pause AUTOMATIC retries (poll/focus) for this long so a
// rate-limit / outage doesn't make us hammer IG. Explicit actions (chat switch,
// live theme change) still retry immediately.
const errorBackoffAt = new Map(); // urlId -> ts of last fetch error
const ERROR_BACKOFF_MS = 30 * 1000;

function parseThreadIdFromPath(pathname = window.location.pathname) {
  const m = pathname.match(/\/direct\/t\/(\d+)/);
  return m ? m[1] : null;
}

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function igGetJson(path) {
  // Throws on network/HTTP failure (callers run inside refresh()'s try/catch,
  // which surfaces it as the header "theme failed" status). A successful response
  // with no theme is NOT an error — that's handled upstream as "no theme".
  const res = await fetch("https://www.instagram.com" + path, {
    method: "GET",
    credentials: "include",
    headers: {
      "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": csrfToken(),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText + " — GET " + path);
  return await res.json();
}

function threadContainer() {
  return (
    document.querySelector('[data-pagelet="IGDMessagesList"]') ||
    document.querySelector('[data-pagelet="IGDOpenMessageList"]') ||
    document.querySelector('[aria-label*="Messages in conversation"]') ||
    null
  );
}

// The whole conversation pane (header + message list + composer): the nearest
// ancestor of the message list that also contains the DM header. We theme this
// so the background + colours span the entire chat, not just the scroll area.
function paneRoot() {
  const list = threadContainer();
  if (!list) return null;
  let el = list.parentElement;
  for (let i = 0; i < 8 && el; i++) {
    if (el.querySelector('[data-pagelet="IGDInboxHeaderOffMsys"]')) return el;
    el = el.parentElement;
  }
  return list;
}

// IG's own dark/light toggle (more accurate than the OS setting alone).
function isDarkMode() {
  const el = document.documentElement;
  if (el.classList.contains("__fb-dark-mode")) return true;
  if (el.classList.contains("__fb-light-mode")) return false;
  if (document.querySelector(".__fb-dark-mode")) return true;
  if (document.querySelector(".__fb-light-mode")) return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

// ---- colour helpers (theme colours are ARGB hex, alpha-first) ----
function argbToRgba(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.replace(/^#/, "").trim();
  let a = 1;
  if (h.length === 8) {
    a = parseInt(h.slice(0, 2), 16) / 255;
    h = h.slice(2);
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a,
  };
}
const rgbaStr = (c) => "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + c.a + ")";
const tripleStr = (c) => c.r + " " + c.g + " " + c.b; // for rgb(var(--…)) style vars

function gradientCss(colors) {
  const rgbs = (colors || []).map(argbToRgba).filter(Boolean);
  if (!rgbs.length) return null;
  let stops;
  if (rgbs.length === 1) {
    const c = rgbs[0];
    const light = { r: Math.round(c.r + (255 - c.r) * 0.16), g: Math.round(c.g + (255 - c.g) * 0.16), b: Math.round(c.b + (255 - c.b) * 0.16), a: c.a };
    const dark = { r: Math.round(c.r * 0.88), g: Math.round(c.g * 0.88), b: Math.round(c.b * 0.88), a: c.a };
    stops = [rgbaStr(light), rgbaStr(dark)];
  } else {
    stops = rgbs.map(rgbaStr);
  }
  return "linear-gradient(160deg, " + stops.join(", ") + ")";
}

function largestAsset(asset) {
  if (!asset || typeof asset !== "object") return null;
  const order = [
    "two_thousand_forty_eight", "one_thousand_twenty_four", "seven_hundred_twenty",
    "four_hundred_eighty", "two_hundred", "one_hundred", "seventy_five", "fifty",
  ];
  for (const k of order) if (typeof asset[k] === "string" && /^https?:/.test(asset[k])) return asset[k];
  for (const k of Object.keys(asset)) if (typeof asset[k] === "string" && /^https?:/.test(asset[k])) return asset[k];
  return null;
}

// Pick the theme variant for the current mode. Top-level theme_data is one mode;
// alternative_themes holds the other(s); each carries app_color_mode.
function pickVariant(td, dark) {
  const all = [td].concat(Array.isArray(td.alternative_themes) ? td.alternative_themes : []);
  const usable = all.filter(
    (v) => v && ((Array.isArray(v.gradient_colors) && v.gradient_colors.length) || v.thread_background_color)
  );
  const want = dark ? "DARK" : "NORMAL";
  return (
    usable.find((v) => v.app_color_mode === want) ||
    usable.find((v) => (dark ? v.app_color_mode === "DARK" : v.app_color_mode !== "DARK")) ||
    usable[0] ||
    td
  );
}

function extractTheme(thread) {
  if (!thread) return null;
  const td = thread.theme_data;
  const themeId = (thread.theme && thread.theme.id) || (td && td.theme_id) || null;
  return { themeId, name: (td && td.name) || null, data: td || null };
}

async function fetchTheme(canonicalId) {
  const json = await igGetJson(
    "/api/v1/direct_v2/threads/" + canonicalId +
      "/?visual_message_return_type=unseen&limit=1"
  );
  return extractTheme(json && json.thread);
}

// Cached theme fetch. Returns the cached theme unless it's stale, forceFetch is
// set, or the cached entry is "partial" (colors only, derived from the inbox
// response — it lacks the background image, so we must do the full thread fetch).
async function fetchThemeCached(canonicalId, forceFetch) {
  const cached = themeCache.get(canonicalId);
  if (!forceFetch && cached && !cached.partial && Date.now() - cached.ts < THEME_TTL_MS) {
    return cached.theme;
  }
  const theme = await fetchTheme(canonicalId);
  themeCache.set(canonicalId, { theme, ts: Date.now(), partial: false });
  return theme;
}

function clearTheme() {
  const pane = document.querySelector("[data-instafn-dm-pane]");
  if (pane) {
    pane.style.backgroundImage = "";
    pane.style.backgroundColor = "";
    pane.style.backgroundSize = "";
    pane.style.backgroundPosition = "";
    pane.style.backgroundRepeat = "";
    THEME_VARS.forEach((p) => pane.style.removeProperty(p));
    delete pane.dataset[PANE_FLAG];
  }
  const list = document.querySelector("[data-instafn-dm-bg]");
  if (list) {
    list.style.backgroundColor = "";
    list.style.backgroundImage = "";
    delete list.dataset[BG_FLAG];
  }
  const s = document.getElementById(STYLE_ID);
  if (s) s.textContent = "";
}

function ensureStyleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(el);
  }
  return el;
}

// Persistent styles (installed once, only when the DM Background setting is on —
// initDMThemeDebug only runs in that case).
//  - Inset EVERY chat row in the thread list a touch from the right edge, so the
//    selected AND hover highlight pills don't run into the edge. Applied to all
//    rows (not just :hover) so hovering never shifts the left-aligned content.
//  - Spinner keyframes for the header theme-status indicator.
function installPersistentStyles() {
  if (document.getElementById(THREADLIST_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = THREADLIST_STYLE_ID;
  el.textContent =
    '[data-pagelet="IGDInboxThreadListScrollableAreaPagelet"] div[role="button"].x1mg3h75' +
    "{margin-right:16px !important;}" +
    "@keyframes instafn-dm-spin{to{transform:rotate(360deg);}}" +
    ".instafn-dm-spinner{animation:instafn-dm-spin 1s linear infinite;transform-origin:center;}";
  (document.head || document.documentElement).appendChild(el);
}

// The header action bar (the row holding the call / video / info icons).
function statusBar() {
  const header = document.querySelector('[data-pagelet="IGDInboxHeaderOffMsys"]');
  if (!header) return null;
  const svg = header.querySelector(
    'svg[aria-label="Audio call"], svg[aria-label="Video call"], svg[aria-label="Conversation information"]'
  );
  const btn = svg ? svg.closest('[role="button"]') : null;
  return btn ? btn.parentElement : null;
}

// Spinner while the theme is fetching, an error glyph (click to copy) if it fails,
// nothing when idle. Rendered as the FIRST child of the header action bar so it
// sits to the left of the call icon. Idempotent; re-runs survive header rerenders.
function ensureStatusIcon() {
  const bar = statusBar();
  let el = document.getElementById(STATUS_ID);
  if (themeStatusState === "idle") {
    if (el) el.remove();
    return;
  }
  if (!bar) return;
  if (!el) {
    el = document.createElement("div");
    el.id = STATUS_ID;
    el.style.cssText =
      "display:flex;align-items:center;justify-content:center;width:24px;height:24px;margin-right:8px;flex:0 0 auto;";
  }
  if (bar.firstChild !== el) bar.insertBefore(el, bar.firstChild);
  if (el.dataset.state !== themeStatusState) {
    el.dataset.state = themeStatusState;
    if (themeStatusState === "loading") {
      // Match the sibling header icons exactly: read a call/video/info icon's
      // computed colour (white in dark, dark in light, or the themed nav colour)
      // and use it for the spinner. Inline !important so it sticks.
      const sib = bar.querySelector(
        'svg[aria-label="Audio call"], svg[aria-label="Video call"], svg[aria-label="Conversation information"]'
      );
      const col = sib
        ? getComputedStyle(sib).color
        : isDarkMode()
        ? "#ffffff"
        : "#000000";
      el.style.setProperty("color", col, "important");
      el.style.cursor = "default";
      el.title = "Theme is loading…";
      el.onclick = null;
      // Same geometry as the info icon (24 viewBox, r=10.5, stroke-width 2, round
      // caps), drawn as a 3/4 arc (gap via dash) and rotated, so it matches the
      // sibling header icons exactly. circumference 2π·10.5 ≈ 65.97 → 49.5 on / 16.5 off.
      el.innerHTML =
        '<svg class="instafn-dm-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-label="Theme is loading" role="img">' +
        '<circle cx="12" cy="12" r="10.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="49.5 16.5"/>' +
        "</svg>";
    } else if (themeStatusState === "error") {
      // inline !important beats the header navText color rule (also !important).
      el.style.setProperty("color", "#ed4956", "important"); // IG error red
      el.style.cursor = "pointer";
      el.title = "Theme failed to load — click to copy error";
      el.innerHTML =
        '<svg height="20" width="20" viewBox="0 0 24 24" fill="currentColor" aria-label="Theme error" role="img">' +
        '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5a1 1 0 0 1 2 0v6a1 1 0 0 1-2 0Zm1 12.2a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Z"/></svg>';
      el.onclick = () => {
        const msg = themeStatusError || "Unknown error";
        // Keep dataset.state === "error" so the throttled re-ensure doesn't clobber
        // the "Copied!" tooltip; it persists until the next real state change.
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(msg).then(() => {
            el.title = "Copied!";
          }).catch(() => {});
        }
      };
    }
  }
}

function setThemeStatus(state, err) {
  themeStatusState = state;
  if (state === "error") themeStatusError = err || "Unknown error";
  ensureStatusIcon();
}

function applyTheme(themeData, dark) {
  const pane = paneRoot();
  const list = threadContainer();
  if (!pane) return false;
  const v = pickVariant(themeData, dark);
  if (!v) return false;

  const colors = Array.isArray(v.gradient_colors) ? v.gradient_colors : [];
  const grad = gradientCss(colors);
  const bgImg = largestAsset(v.thread_background_asset);
  const bgColor = argbToRgba(v.thread_background_color);
  const inc = argbToRgba(v.incoming_message_bubble_color);
  const outSolid = argbToRgba(colors[0] || v.fallback_color);
  const accent = argbToRgba(v.emphasized_action_color || v.fallback_color || colors[0]);
  const outText = argbToRgba(v.outbound_message_text_color);
  const incText = argbToRgba(v.inbound_message_text_color);
  const navText = argbToRgba(v.navigation_bar_title_color || v.navigation_bar_icon_color);
  const composerBtn = argbToRgba(v.composer_secondary_button_color) || navText;
  const composerBg = argbToRgba(v.solid_composer_background_color || v.thread_background_color);
  const composerInput = argbToRgba(v.composer_input_background_color) || composerBg;
  // The message-bar (input pill) colour — also reused for reaction pills so they
  // match. AI themes ship a near-black composer_input_background_color, so for them
  // derive from the lavender accent (darker in dark mode, lighter in light mode).
  const isAITheme = /ai theme/i.test((themeData.name || "").trim());
  const lavBase = outSolid || inc || bgColor;
  let pillColor = composerInput;
  if (isAITheme && lavBase) {
    pillColor = dark
      ? { r: Math.round(lavBase.r * 0.5), g: Math.round(lavBase.g * 0.5), b: Math.round(lavBase.b * 0.5), a: 1 }
      : {
          r: Math.round(lavBase.r + (255 - lavBase.r) * 0.55),
          g: Math.round(lavBase.g + (255 - lavBase.g) * 0.55),
          b: Math.round(lavBase.b + (255 - lavBase.b) * 0.55),
          a: 1,
        };
  }

  pane.dataset[PANE_FLAG] = "1";

  // Background image spans the WHOLE pane (header + messages + composer), lightly
  // scrimmed in the theme's base colour for legibility.
  if (bgColor) pane.style.backgroundColor = rgbaStr(bgColor);
  if (bgImg) {
    const s = bgColor
      ? "rgba(" + bgColor.r + ", " + bgColor.g + ", " + bgColor.b + ", 0.4)"
      : "rgba(0, 0, 0, 0.4)";
    pane.style.backgroundImage =
      "linear-gradient(" + s + ", " + s + '), url("' + bgImg + '")';
    pane.style.backgroundSize = "cover";
    pane.style.backgroundPosition = "center";
    pane.style.backgroundRepeat = "no-repeat";
  } else if (grad) {
    pane.style.backgroundImage = grad;
  }
  // Let the pane background show through the scroll list, header and composer.
  if (list) {
    list.style.backgroundColor = "transparent";
    list.style.backgroundImage = "none";
    list.dataset[BG_FLAG] = "1";
  }

  const set = (k, val) => {
    if (val != null) pane.style.setProperty(k, val);
  };
  if (accent) set("--mwp-primary-theme-color", rgbaStr(accent));
  if (inc) {
    set("--ig-incoming-message-bubble", tripleStr(inc));
    set("--chat-incoming-message-bubble-background-color", rgbaStr(inc));
  }
  if (outSolid) {
    set("--ig-outgoing-message-bubble", tripleStr(outSolid));
    set("--chat-outgoing-message-bubble-background-color", rgbaStr(outSolid));
  }
  // Header: transparent so the pane image shows behind it. Composer (message
  // bar) outer area: the theme's solid composer colour.
  set("--mwp-header-background-color", "transparent");
  // Composer surround = thread background (blends with the chat); the pill itself
  // gets the solid composer colour below so it stands out.
  if (bgColor) set("--chat-composer-background-color", rgbaStr(bgColor));

  // Forced colours (the var chains IG uses for text are unreliable to override):
  //   - outgoing bubble: theme gradient + outbound text colour
  //   - incoming bubble text: inbound text colour
  //   - header + composer icons/text: nav / composer button colours
  const P = "[data-instafn-dm-pane] ";
  const rules = [];
  // Sent bubble = solid theme colour (matches the mobile app; no gradient).
  if (outSolid)
    rules.push(
      P + OUTGOING_BUBBLE_SELECTOR +
        "{background-image:none !important;background-color:" + rgbaStr(outSolid) + " !important;}"
    );
  if (outText) rules.push(P + OUTGOING_BUBBLE_SELECTOR + ", " + P + OUTGOING_BUBBLE_SELECTOR + " *{color:" + rgbaStr(outText) + " !important;}");
  if (incText) rules.push(P + INCOMING_BUBBLE_SELECTOR + ", " + P + INCOMING_BUBBLE_SELECTOR + " *{color:" + rgbaStr(incText) + " !important;}");
  // Corner mask: IG fakes grouped-bubble corners with a 10px outline/box-shadow
  // (class .x1k4qllp) painted in --mwp-message-row-background, sitting over a dark
  // message-row background. A solid carve covers that dark layer; making the carve
  // transparent just exposes it (black notches over the image). The true fix is to
  // remove the outline/box-shadow on the bubbles so the rounded bubble floats
  // directly on the themed background — corners show the real image through.
  rules.push("[data-instafn-dm-bg] *{--mwp-message-row-background:transparent !important;}");
  rules.push(
    "[data-instafn-dm-bg] " + INCOMING_BUBBLE_SELECTOR + ", " +
      "[data-instafn-dm-bg] " + OUTGOING_BUBBLE_SELECTOR +
      "{outline:none !important;box-shadow:none !important;}"
  );
  // Shared posts/reels sent in chat are rich cards whose dark surfaces are
  // card-specific elements (NOT --card-background): the rounded body (.xlp1x4z /
  // .x1pczhz8) AND the author header strip + caption strip (.xz9dl7a.xpdmqnj
  // .xsag5q8.x1g0dm76). Colour those so the whole card reads as a chat surface.
  // EXCLUDE absolute OVERLAY elements that share those 4 classes — the reel "Clip"
  // badge (bottom-left) and a reel's header overlay (over the video) — via the
  // overlay classes x1ey2m1c / x10l6tqk / x1vjfegm, so the badge keeps its native
  // look and the reel header stays transparent.
  if (inc) {
    const card = rgbaStr(inc);
    rules.push(
      "[data-instafn-dm-bg] .xlp1x4z, " +
        "[data-instafn-dm-bg] .x1pczhz8, " +
        "[data-instafn-dm-bg] .xz9dl7a.xpdmqnj.xsag5q8.x1g0dm76:not(.x1ey2m1c):not(.x10l6tqk):not(.x1vjfegm)" +
        "{background-color:" + card + " !important;background-image:none !important;}"
    );
  }
  // Reaction pill (e.g. "❤️ 2" under a message) = the SAME colour as the message
  // bar (input pill). Target the pill container by its distinctive class combo.
  if (pillColor) {
    rules.push(
      "[data-instafn-dm-bg] .xu2v3tx.x1rpy9zp.x1iajtwn" +
        "{background-color:" + rgbaStr(pillColor) + " !important;}"
    );
  }
  // Remove the header's bottom separator line. IG draws it on the header pagelet's
  // own wrapper chain (it has moved between class names — currently a child div of
  // the pagelet), so cover the pagelet, its descendants, its parent and grandparent,
  // plus any ::after, with border-bottom:none + box-shadow:none.
  const HDR = '[data-pagelet="IGDInboxHeaderOffMsys"]';
  rules.push(
    P + HDR + ", " +
      P + HDR + " > *, " +
      P + HDR + " > * > *, " +
      P + ":has(> " + HDR + "), " +
      P + ":has(> * > " + HDR + ")" +
      "{border-bottom:none !important;box-shadow:none !important;}"
  );
  rules.push(
    P + HDR + "::after, " +
      P + HDR + " > *::after, " +
      P + ":has(> " + HDR + ")::after" +
      "{display:none !important;}"
  );
  if (navText) rules.push(P + '[data-pagelet="IGDInboxHeaderOffMsys"], ' + P + '[data-pagelet="IGDInboxHeaderOffMsys"] *{color:' + rgbaStr(navText) + " !important;}");
  if (composerBtn) rules.push(P + '[data-pagelet^="IGDComposer"] svg, ' + P + '[data-pagelet^="IGDComposer"] [contenteditable]{color:' + rgbaStr(composerBtn) + " !important;}");
  // The input pill + "Replying to…" bar render black: IG derives their surfaces
  // from the base IG background TRIPLES. Map every composer surface to the thread
  // background (so the reply bar blends with the chat) and drop composer borders.
  // Emoji/sticker popups are in a portal, untouched.
  if (bgColor || composerInput) {
    const baseC = rgbaStr(bgColor || composerInput);
    const baseTri = tripleStr(bgColor || composerInput);
    rules.push(
      P + '[data-pagelet^="IGDComposer"] *{' +
        "--ig-primary-background:" + baseTri + " !important;" +
        "--ig-secondary-background:" + baseTri + " !important;" +
        "--ig-elevated-background:" + baseTri + " !important;" +
        "--ig-highlight-background:" + baseTri + " !important;" +
        "--ig-banner-background:" + baseTri + " !important;" +
        "--comment-background:" + baseC + " !important;" +
        "--card-background:" + baseC + " !important;" +
        "--messenger-card-background:" + baseC + " !important;" +
        "border-color:transparent !important;box-shadow:none !important;}"
    );
    // Kill the drop shadow / scroll-shadow that sits above the composer bar (on the
    // composer pagelet and the wrapper around it).
    rules.push(
      P + '[data-pagelet^="IGDComposer"], ' +
        P + ':has(> [data-pagelet^="IGDComposer"])' +
        "{box-shadow:none !important;}"
    );
    // Input pill = pillColor (hoisted above; composer_input_background_color, or a
    // mode-aware lavender for AI themes). Target the rounded container holding the
    // text input (not the round icon buttons / reply bar).
    if (pillColor) {
      rules.push(
        P + '[data-pagelet^="IGDComposer"] .x1ua1ujl.xksyday:has([contenteditable])' +
          "{background-color:" + rgbaStr(pillColor) + " !important;}"
      );
    }
  }
  ensureStyleEl().textContent = rules.join("\n");
  return true;
}

// One inbox call returns ~20 threads. Cache the canonical-id resolution for ALL
// of them (keyed by every id form IG might put in the URL) AND a PARTIAL theme
// (colors from the inbox; no background image) per thread. So after the first
// inbox fetch, switching to any recent chat needs no inbox call, and its colours
// can paint instantly while the full thread (with the bg image) loads.
function ingestInboxThreads(threads) {
  const now = Date.now();
  for (const t of threads) {
    const cid = String(t.thread_id || t.thread_v2_id || "");
    if (!cid) continue;
    [t.thread_id, t.thread_v2_id, t.thread_fbid].forEach((k) => {
      if (k != null) canonicalByUrlId.set(String(k), cid);
    });
    if (!t.is_group) {
      (t.users || []).forEach((u) => {
        [u.pk, u.fbid, u.id, u.interop_messaging_user_fbid].forEach((k) => {
          if (k != null) canonicalByUrlId.set(String(k), cid);
        });
      });
    }
    const existing = themeCache.get(cid);
    if (!existing || existing.partial) {
      themeCache.set(cid, { theme: extractTheme(t), ts: now, partial: true });
    }
  }
}

async function resolveCanonicalId(urlId) {
  if (canonicalByUrlId.has(urlId)) return canonicalByUrlId.get(urlId);
  // Don't hammer the inbox for a chat we just failed to resolve (e.g. not in the
  // top-20 inbox). Retry at most once a minute.
  const missTs = canonicalMissAt.get(urlId);
  if (missTs && Date.now() - missTs < CANONICAL_MISS_TTL_MS) return null;
  const inbox = await igGetJson(
    "/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=1&persistentBadging=true&limit=20"
  );
  const threads = (inbox && inbox.inbox && inbox.inbox.threads) || [];
  ingestInboxThreads(threads);
  if (canonicalByUrlId.has(urlId)) {
    canonicalMissAt.delete(urlId);
    return canonicalByUrlId.get(urlId);
  }
  // Fuzzy fallback for a urlId form ingest didn't key directly.
  const pick = threads.find((t) => JSON.stringify(t).indexOf(urlId) !== -1);
  const id = pick && String(pick.thread_id || pick.thread_v2_id || "");
  if (id) {
    canonicalByUrlId.set(urlId, id);
    canonicalMissAt.delete(urlId);
    return id;
  }
  canonicalMissAt.set(urlId, Date.now());
  return null;
}

// The current chat's already-resolved theme, kept in memory so we can re-apply it
// instantly (switching back to a chat, or after IG re-renders the pane) with no
// await and no network.
let current = null; // { urlId, theme }

// Apply current.theme to the DOM. Synchronous + network-free → instant. Safe to
// call repeatedly: no-ops when the theme is already applied and the pane is still
// present, and otherwise (re)applies — so it themes the pane the moment it renders
// and restores styling if IG re-rendered over it.
function applyCurrent(forceApply) {
  if (!current) return;
  const urlId = parseThreadIdFromPath();
  if (!urlId || urlId !== current.urlId) return;
  const theme = current.theme;
  const dark = isDarkMode();
  lastDark = dark;
  const hasTheme = theme && theme.data && theme.themeId !== DEFAULT_THEME_ID;
  const key = urlId + "|" + (hasTheme ? theme.themeId + ":" + (dark ? "D" : "L") : "default");
  // Consider it applied only if BOTH the pane and the message-list flags are still
  // present. IG re-renders the message list when the reply bar opens/closes; if we
  // only checked the pane we'd skip re-applying and the list-scoped rules (corner
  // mask, etc.) would be lost on the fresh list — re-apply when either is missing.
  const themed =
    !!document.querySelector("[data-instafn-dm-pane]") &&
    !!document.querySelector("[data-instafn-dm-bg]");
  if (!forceApply && key === lastAppliedKey && (!hasTheme || themed)) return;
  if (hasTheme) {
    if (applyTheme(theme.data, dark)) lastAppliedKey = key;
  } else {
    clearTheme();
    lastAppliedKey = key;
  }
}

// Resolve the current chat's theme (canonical id + theme, both cached) into
// `current`, then apply. Network only on cache miss / TTL expiry / forceFetch.
async function refresh(forceApply, forceFetch) {
  const urlId = parseThreadIdFromPath();
  if (!urlId) {
    clearTheme();
    lastAppliedKey = null;
    current = null;
    setThemeStatus("idle");
    return;
  }
  // After a fetch error, let only EXPLICIT actions (chat switch / live theme change)
  // retry within the backoff window; suppress the poll/focus auto-retries so we
  // don't hammer IG (e.g. during a rate-limit) and risk a block.
  const auto = !forceApply && !forceFetch;
  if (auto) {
    const eb = errorBackoffAt.get(urlId);
    if (eb && Date.now() - eb < ERROR_BACKOFF_MS) return;
  }
  if (resolving) return;
  resolving = true;
  // Show the spinner only when this will actually touch the network (a cache miss,
  // a stale/partial entry, or a forced refetch) — fully-cached chats apply instantly.
  const cid0 = canonicalByUrlId.get(urlId);
  const cached0 = cid0 ? themeCache.get(cid0) : null;
  const willFetch =
    forceFetch || !cid0 || !cached0 || cached0.partial || Date.now() - cached0.ts >= THEME_TTL_MS;
  // Spinner only on a COLD load (nothing to show yet). If colours are already
  // cached (partial from the inbox, or a full revisit), paint them and let the
  // background-image upgrade fetch silently — no spinner.
  const havePaint = !!(cached0 && cached0.theme && cached0.theme.data);
  if (willFetch && !havePaint) setThemeStatus("loading");
  try {
    const canonicalId = await resolveCanonicalId(urlId);
    if (parseThreadIdFromPath() !== urlId) return;
    if (!canonicalId) {
      // Couldn't resolve the thread (not in inbox) — not a fetch error; just no theme.
      setThemeStatus("idle");
      return;
    }
    // Phase 1: paint colours immediately from the inbox-derived partial theme (no
    // extra network) so the chat isn't blank while the full theme loads.
    if (willFetch) {
      const partial = themeCache.get(canonicalId);
      if (partial && partial.theme && partial.theme.data) {
        current = { urlId, theme: partial.theme };
        applyCurrent(forceApply);
      }
    }
    // Phase 2: full theme (adds the background image). No-ops the network if a
    // fresh full entry already exists (e.g. a cached revisit).
    const theme = await fetchThemeCached(canonicalId, forceFetch);
    if (parseThreadIdFromPath() !== urlId) return;
    current = { urlId, theme };
    errorBackoffAt.delete(urlId);
    setThemeStatus("idle");
    applyCurrent(willFetch ? true : forceApply);
  } catch (e) {
    errorBackoffAt.set(urlId, Date.now());
    setThemeStatus("error", (e && (e.stack || e.message)) || String(e));
  } finally {
    resolving = false;
  }
}

function handleNavigation() {
  const urlId = parseThreadIdFromPath();
  if (urlId !== currentUrlId) {
    currentUrlId = urlId;
    lastAppliedKey = null;
    current = null;
    clearTheme();
    // Switch: resolve from cache (no ping for seen chats); applyCurrent then runs
    // on each render mutation below, so a cached theme paints as soon as the pane
    // exists — no 250ms debounce, no waiting on the poll.
    if (urlId) refresh(true, false);
  }
}

let lastThemeMsgRefresh = 0;
let lastApplyTick = 0;
function onMutation(mutations) {
  // Detect chat switches immediately (guarded by URL change — no debounce).
  if (parseThreadIdFromPath() !== currentUrlId) handleNavigation();
  // Paint from the in-memory cache as soon as the new pane renders, and restore
  // styling if IG re-rendered over it. Sync + network-free; throttled lightly.
  const now = Date.now();
  if (now - lastApplyTick > 50) {
    lastApplyTick = now;
    applyCurrent(false);
    ensureStatusIcon(); // re-insert spinner/error glyph if IG re-rendered the header
  }
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1 && /changed the theme to/i.test(node.textContent || "")) {
        if (now - lastThemeMsgRefresh > 3000) {
          lastThemeMsgRefresh = now;
          // Live theme change: bypass the cache and refetch this chat's theme.
          refresh(true, true);
        }
        return;
      }
    }
  }
}

function initDMThemeDebug() {
  installPersistentStyles();
  handleNavigation();
  if (!navObserver) {
    navObserver = new MutationObserver(onMutation);
    navObserver.observe(document.body, { childList: true, subtree: true });
  }
  // Re-apply when IG's light/dark mode flips (its own toggle changes the root
  // class; the OS setting can also change).
  if (!htmlObserver) {
    lastDark = isDarkMode();
    htmlObserver = new MutationObserver(() => {
      const d = isDarkMode();
      if (d !== lastDark) {
        lastDark = d;
        // Mode flip: re-apply the other variant straight from the cached theme
        // (instant, no ping — theme_data carries both light and dark palettes).
        applyCurrent(true);
      }
    });
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
          applyCurrent(true);
        });
      } catch (_) {}
    }
  }
  if (!pollTimer) {
    // Light keep-alive: re-apply if IG re-rendered the pane. Uses the cache, so it
    // only touches the network when a chat's cached theme has gone stale (TTL).
    pollTimer = setInterval(() => {
      if (parseThreadIdFromPath()) refresh(false, false);
    }, POLL_MS);
  }
  window.addEventListener("focus", () => {
    if (parseThreadIdFromPath()) refresh(false, false);
  });
  console.log("[Instafn DM-bg] active — theme (mode-aware) applied to bubbles, background & reactions.");
}


module.exports.initDMThemeDebug = initDMThemeDebug;
});


defineModule("features/media-downloader/index.js", function (module, exports, require) {
/**
 * Media Downloader — orchestrator.
 *
 * Owns lifecycle for all the per-surface injectors: reads the settings, wires a
 * single debounced MutationObserver + a light interval + url-change re-scan
 * (Instagram is a heavily virtualized SPA, so buttons must be re-applied as the
 * DOM recycles), and tears everything down when disabled. Every injector is
 * idempotent, so re-scanning is cheap.
 */

var { injectStylesheet } = require("utils/styleLoader.js");
var { injectScript } = require("utils/scriptInjector.js");
var { watchUrlChanges } = require("utils/domObserver.js");
var { SETTINGS_KEYS, DOWNLOAD_DEFAULTS } = require("features/media-downloader/config.js");
var { injectPostButtons, removePostButtons } = require("features/media-downloader/inject-posts.js");
var { injectReelButtons, removeReelButtons } = require("features/media-downloader/inject-reels.js");
var { injectStoryButton, removeStoryButton } = require("features/media-downloader/inject-stories.js");
var { injectProfilePicButton, removeProfilePicButton } = require("features/media-downloader/inject-profile-pic.js");
var { injectAudioButtons, removeAudioButtons } = require("features/media-downloader/inject-audio.js");
var { injectChatImageButtons, removeChatImageButtons } = require("features/media-downloader/inject-chat-images.js");

let started = false;
let opts = { ...DOWNLOAD_DEFAULTS };
let observer = null;
let intervalId = null;
let urlCleanup = null;
let scanQueued = false;

function ensureStyles() {
  injectStylesheet(
    "content/features/media-downloader/media-downloader.css",
    "instafn-media-downloader"
  );
}

// Run the enabled injectors. Cheap + idempotent, safe to call often.
function scan() {
  scanQueued = false;
  try {
    if (opts[SETTINGS_KEYS.posts]) injectPostButtons();
    if (opts[SETTINGS_KEYS.reels]) injectReelButtons();
    if (opts[SETTINGS_KEYS.stories]) injectStoryButton();
    if (opts[SETTINGS_KEYS.profilePics]) injectProfilePicButton();
    if (opts[SETTINGS_KEYS.audio]) injectAudioButtons();
    // DM in-chat image downloads (the injector self-limits to /direct/ and image
    // messages).
    if (opts[SETTINGS_KEYS.chatImages]) injectChatImageButtons();
  } catch (err) {
    console.error("[Instafn] media-downloader scan error:", err);
  }
}

function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(scan);
}

function start() {
  if (started) return;
  started = true;
  ensureStyles();

  // Page-context sniffer that captures DM voice-note .ogg urls from the
  // /api/graphql thread payload (the only place they appear). Injected early so
  // it's wrapping fetch/XHR before the conversation loads. Idempotent + harmless
  // when audio downloads are off, but only needed for that path.
  if (opts[SETTINGS_KEYS.audio]) {
    injectScript("content/features/media-downloader/voice-sniffer.js");
  }

  observer = new MutationObserver(() => queueScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Safety net for surfaces that mutate without bubbling childList changes we
  // catch (e.g. story tap-through swapping content in place).
  intervalId = setInterval(scan, 1500);

  urlCleanup = watchUrlChanges(() => {
    // Story/reel/profile context changed — clear stale per-context flags so the
    // new context gets its button immediately.
    queueScan();
    setTimeout(scan, 300);
    setTimeout(scan, 900);
  });

  scan();
  setTimeout(scan, 500);
  setTimeout(scan, 1500);
}

function stop() {
  started = false;
  observer?.disconnect();
  observer = null;
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  urlCleanup?.();
  urlCleanup = null;
  removePostButtons();
  removeReelButtons();
  removeStoryButton();
  removeProfilePicButton();
  removeAudioButtons();
  removeChatImageButtons();
}

/**
 * Initialize from a settings object (the content-script DOMContentLoaded block
 * passes the resolved chrome.storage values straight in).
 */
function initMediaDownloader(settings = {}) {
  opts = { ...DOWNLOAD_DEFAULTS, ...settings };
  const masterOn = !!opts[SETTINGS_KEYS.master];
  if (masterOn) start();
  else stop();
}

/** React to live settings changes from chrome.storage.onChanged. */
function updateMediaDownloaderSettings(settings = {}) {
  initMediaDownloader(settings);
}


module.exports.initMediaDownloader = initMediaDownloader;
module.exports.updateMediaDownloaderSettings = updateMediaDownloaderSettings;
});


defineModule("features/media-downloader/image-source.js", function (module, exports, require) {
/**
 * Full-resolution source for DM photo attachments.
 *
 * The rendered bubble <img> is a downscaled rendition — its fbcdn URL carries an
 * `stp=` transform that caps it at the bubble's display size, so saving that URL
 * yields e.g. a 720p copy of a 2K photo. The ORIGINAL lives in Instagram's
 * private DM API: each thread item exposes `image_versions2.candidates`, the full
 * resolution ladder. We fetch the thread (see dm-thread-api.js), index every
 * image by its CDN media token, and map a rendered bubble to the largest
 * candidate by that token.
 *
 * Every rung of one image shares the same long numeric id in its filename, so the
 * rendered (small) URL and the API's (large) URL match on that token — the same
 * trick the post carousel uses to line a slide up with its API entry.
 */

var { fetchThreadItems } = require("features/media-downloader/dm-thread-api.js");

// The long numeric id in a CDN media filename, shared across every rendition of
// the same image. Position-independent, so it survives IG's URL transforms.
function mediaToken(url) {
  try {
    const file = new URL(url, location.href).pathname.split("/").pop() || "";
    const m = file.match(/\d{10,}/);
    return m ? m[0] : "";
  } catch (_) {
    return "";
  }
}

// Normalize an image_versions2 candidate list into sorted {url,width,height}
// rungs (largest first), dropping urlless entries.
function normCandidates(cands) {
  return [...cands]
    .filter((c) => c && c.url)
    .map((c) => ({ url: c.url, width: c.width || 0, height: c.height || 0 }))
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

// Walk a thread item, mapping every image's token(s) -> its full candidate
// ladder. Shape-agnostic: photo messages nest the media differently across
// backends, so we recurse and key off any image_versions2 we find.
function indexItem(item, byToken) {
  const seen = new Set();
  (function walk(v) {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    const cands = v.image_versions2?.candidates;
    if (Array.isArray(cands) && cands.length) {
      const ladder = normCandidates(cands);
      if (ladder.length) {
        // Key by EVERY rung's token (they're identical in practice, but a few
        // backends differ) so the rendered URL always finds the ladder.
        for (const c of cands) {
          const t = mediaToken(c.url);
          if (t && !byToken.has(t)) byToken.set(t, ladder);
        }
      }
    }
    for (const k in v) walk(v[k]);
  })(item);
}

const TTL_MS = 30 * 1000;
let cache = null; // { ts, byToken:Map<token, candidates[]> }

async function getImageMap(force) {
  if (!force && cache && Date.now() - cache.ts < TTL_MS) return cache;
  const items = await fetchThreadItems(2); // best-effort: two newest pages
  const byToken = new Map();
  for (const it of items) indexItem(it, byToken);
  cache = { ts: Date.now(), byToken };
  return cache;
}

/**
 * Resolve a rendered DM image URL to its full-resolution original via the thread
 * API. Returns { url, candidates } (largest first), or null when it can't be
 * matched (caller should then fall back to the rendered URL).
 */
async function resolveFullImage(renderedUrl) {
  const token = mediaToken(renderedUrl);
  if (!token) return null;

  let map = await getImageMap(false);
  let ladder = map.byToken.get(token);
  if (!ladder) {
    // Cache miss (e.g. an image loaded after our last fetch) — refresh once.
    map = await getImageMap(true);
    ladder = map.byToken.get(token);
  }
  if (!ladder || !ladder.length) return null;
  return { url: ladder[0].url, candidates: ladder };
}


module.exports.resolveFullImage = resolveFullImage;
});


defineModule("features/media-downloader/inject-posts.js", function (module, exports, require) {
/**
 * Post download button — feed posts, permalink (/p/, /reel/, /tv/) pages and the
 * post lightbox dialog. All render the standard action bar (Like / Comment /
 * Share … Save).
 *
 * We clone the Share (send) button and drop the clone in right before it, so the
 * button lines up pixel-for-pixel with the native icons and the like/comment
 * counts are never touched. Carousels resolve to every child automatically.
 *
 * Two container shapes exist:
 *  - Classic: the post is an <article> with the action bar inside it (feed,
 *    lightbox dialog).
 *  - Redesigned permalink: there is NO <article> — the media and the action bar
 *    live in separate columns under a shared wrapper, and the action bar is a
 *    bare <section> (it also carries inline counts + a Repost button). We anchor
 *    on that <section> directly.
 */

var { extractShortcode, resolveByShortcode } = require("features/media-downloader/ig-api.js");
var { handlePostDownload } = require("features/media-downloader/carousel.js");
var { findSendButton, buildDownloadClone, commonAncestor, rowItem, ITEM_CLASS } = require("features/media-downloader/inject-common.js");

const FLAG = "data-instafn-dl-post";

// The post's own shortcode: prefer the permalink that wraps the timestamp, then
// any post link inside the scope, then the page URL on permalink routes.
// `scope` may be an <article>, a <section>, or document — extractShortcode pulls
// the post code even out of a comment permalink (/p/<code>/c/<id>/).
function shortcodeForScope(scope) {
  const timeLink = scope.querySelector(
    'a:has(time)[href*="/p/"], a:has(time)[href*="/reel/"], a:has(time)[href*="/tv/"]'
  );
  let code = extractShortcode(timeLink?.getAttribute("href"));
  if (code) return code;

  const anyLink = scope.querySelector(
    'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
  );
  code = extractShortcode(anyLink?.getAttribute("href"));
  if (code) return code;

  return extractShortcode(location.pathname);
}

// The element used to detect which carousel slide is on screen. In the classic
// layout the <article> contains the media; in the redesigned permalink the media
// sits in a sibling column, so climb from the action bar to the nearest ancestor
// that also contains the carousel (its dot strip `._acnc`). Single-media posts
// have no dots — `root` is unused for them, so falling back to `scope` is safe.
function carouselRootFor(scope) {
  let node = scope;
  for (let i = 0; node && node !== document.body && i < 12; i++) {
    if (node.querySelector?.("._acnc")) return node;
    node = node.parentElement;
  }
  return scope;
}

// Place the download button inside an already-located action bar.
//  - `scope`: element to flag for dedup + search the action buttons within.
//  - `root`:  element for carousel slide detection (see carouselRootFor).
//  - `code`:  the post shortcode.
function injectIntoActionBar(scope, root, code) {
  if (!scope || scope.getAttribute(FLAG) === "1") return;
  if (scope.querySelector(`.${ITEM_CLASS}`)) {
    scope.setAttribute(FLAG, "1");
    return;
  }

  // Anchor on Comment — it's present even when likes (and with them the Share
  // button) are hidden. The download slot is "right after Comment", which is
  // exactly before Share when Share exists, and the natural Share slot when it
  // doesn't. Fall back to Like if a post somehow has no comment button.
  const commentBtn = scope
    .querySelector('svg[aria-label="Comment"]')
    ?.closest('[role="button"]');
  const likeBtn = scope
    .querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]')
    ?.closest('[role="button"]');
  const anchorBtn = commentBtn || likeBtn;
  if (!anchorBtn) return; // action bar not rendered yet
  if (!code) return;

  const opts = {
    label: "Download post",
    surface: "post",
    // Pass the carousel root so a carousel can detect which slide is on screen.
    onClick: () => handlePostDownload(() => resolveByShortcode(code), root),
  };

  const sendBtn = findSendButton(scope);
  let row, template, before;
  if (sendBtn) {
    // Exact: clone the Share row-item and insert it right before Share.
    row = commonAncestor(anchorBtn, sendBtn) || sendBtn.parentNode;
    template = rowItem(row, sendBtn);
    before = template;
  } else {
    // No Share (e.g. likes hidden): clone the Comment row-item and append it to
    // the END of the action group. Appending (rather than inserting right after
    // Comment) avoids landing between the Comment icon and its inline count span
    // — IG renders the comment count as a sibling right after the button.
    row =
      (likeBtn && commentBtn && commonAncestor(likeBtn, commentBtn)) ||
      anchorBtn.parentElement;
    template = rowItem(row, anchorBtn);
    before = null; // append to the end of the action group
  }
  if (!row || !template) return;

  // Guard against an over-climbed template. A real action-bar item wraps a
  // single control; in the redesigned permalink the row-item heuristic can
  // resolve to the whole action block (every icon + the post timestamp). Cloning
  // that rewrites EVERY svg to the download glyph and ghosts the entire bar
  // below. If the template spans more than one button — or carries a <time> —
  // fall back to cloning just the anchor button and appending it to the anchor's
  // own tight parent (the icon group), where a single download icon belongs.
  if (
    template !== anchorBtn &&
    (template.querySelector("time") ||
      template.querySelectorAll('[role="button"], button').length > 1)
  ) {
    template = anchorBtn;
    row = anchorBtn.parentNode;
    before = null;
  }
  if (!row || !template) return;

  const item = buildDownloadClone(template, opts);
  row.insertBefore(item, before);

  scope.setAttribute(FLAG, "1");
}

// Classic layout: each post is an <article> wrapping its own action bar.
function injectIntoArticle(article) {
  injectIntoActionBar(article, article, shortcodeForScope(article));
}

// Redesigned permalink layout: no <article>. The action bar is a bare <section>;
// the media lives in a sibling column. Skip any section nested in an <article> —
// those are the classic layout, handled above.
//
// Identify the action bar by Like OR Comment, not Comment alone: when the author
// disables comments IG drops the Comment button entirely, so gating on Comment
// skipped those posts (no download button, or it fell through to the wrong
// node). Accepting Like too means we only miss a post that hides BOTH.
function injectIntoBareSection(section) {
  if (section.closest("article")) return;
  if (
    !section.querySelector(
      'svg[aria-label="Comment"], svg[aria-label="Like"], svg[aria-label="Unlike"]'
    )
  )
    return;
  injectIntoActionBar(
    section,
    carouselRootFor(section),
    shortcodeForScope(document)
  );
}

function injectPostButtons() {
  document.querySelectorAll("article").forEach(injectIntoArticle);
  document.querySelectorAll("section").forEach(injectIntoBareSection);
}

function removePostButtons() {
  document
    .querySelectorAll(`[${FLAG}="1"]`)
    .forEach((el) => el.removeAttribute(FLAG));
  document
    .querySelectorAll(`.${ITEM_CLASS}[data-dl-surface="post"]`)
    .forEach((el) => el.remove());
}


module.exports.injectPostButtons = injectPostButtons;
module.exports.removePostButtons = removePostButtons;
});


defineModule("features/media-downloader/zip.js", function (module, exports, require) {
/**
 * Minimal ZIP writer (STORE / no compression) + the "download carousel as .zip"
 * flow.
 *
 * Instagram media is already compressed (JPEG/MP4), so deflate would buy almost
 * nothing — a STORE archive is tiny to implement and produces a perfectly valid
 * .zip. Building the archive needs the raw bytes in the page, which means
 * cross-origin fetches to *.cdninstagram.com / *.fbcdn.net; those hosts are in
 * the extension's host_permissions, so the content script can fetch them without
 * tripping CORS. The finished archive is a same-origin blob: URL, so a plain
 * <a download> saves it.
 */

var { buildFilename, getEmbedMetadata } = require("features/media-downloader/downloader.js");
var { showToast, CHECK_ICON } = require("ui/toast.js");
var { embedMetadataInJpeg, isEmptyMetadata } = require("features/media-downloader/metadata.js");

// ---- CRC-32 (required by the ZIP format) ----------------------------------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- little-endian helpers ------------------------------------------------
const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n) =>
  new Uint8Array([
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]);
function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

// DOS date for 1980-01-01 (a stable, valid timestamp; ZIP needs *something*).
const DOS_TIME = u16(0);
const DOS_DATE = u16(0x21);
const UTF8_FLAG = 0x0800; // filenames are UTF-8

/** Build a STORE-method .zip Blob from [{ name, data: Uint8Array }]. */
function makeZipBlob(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const localHeader = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(UTF8_FLAG), // general purpose flag
      u16(0), // compression: store
      DOS_TIME,
      DOS_DATE,
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(name.length),
      u16(0), // extra length
      name,
    ]);
    parts.push(localHeader, f.data);

    central.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(UTF8_FLAG),
        u16(0), // compression: store
        DOS_TIME,
        DOS_DATE,
        u32(crc),
        u32(size),
        u32(size),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        name,
      ])
    );

    offset += localHeader.length + size;
  }

  const centralBytes = concat(central);
  const eocd = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(files.length), // entries on this disk
    u16(files.length), // total entries
    u32(centralBytes.length),
    u32(offset), // central dir offset
    u16(0), // comment length
  ]);

  return new Blob([...parts, centralBytes, eocd], { type: "application/zip" });
}

function anchorDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

function zipBaseName(media) {
  const bits = [];
  if (media?.username) bits.push(media.username.replace(/[^a-z0-9._-]+/gi, "_"));
  if (media?.code && media.code !== "profile") bits.push(media.code);
  return bits.join("_") || "instagram";
}

/**
 * Fetch every media in `list`, pack them into a .zip and save it. Reports
 * partial failures (e.g. a single item that wouldn't fetch) rather than aborting.
 */
async function buildZipDownload(list) {
  if (!list || !list.length) return;
  showToast(`Zipping ${list.length} items…`, { duration: 2000 });

  const embed = await getEmbedMetadata();

  const files = [];
  let failed = 0;
  for (const m of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resp = await fetch(m.url, { credentials: "omit" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // eslint-disable-next-line no-await-in-loop
      let buf = new Uint8Array(await resp.arrayBuffer());

      // Bake metadata into JPEGs; keep the raw bytes if it's not a JPEG/video.
      if (embed && m.type === "image" && m.metadata && !isEmptyMetadata(m.metadata)) {
        const injected = embedMetadataInJpeg(buf, m.metadata);
        if (injected) buf = injected;
      }
      files.push({ name: buildFilename(m), data: buf });
    } catch (_) {
      failed++;
    }
  }

  if (!files.length) {
    showToast("Couldn't fetch the media to zip.", { duration: 2800 });
    return;
  }

  let blob;
  try {
    blob = makeZipBlob(files);
  } catch (err) {
    showToast(`Zip failed: ${err.message || err}`, { duration: 2800 });
    return;
  }

  const url = URL.createObjectURL(blob);
  anchorDownload(url, `${zipBaseName(list[0])}.zip`);
  setTimeout(() => URL.revokeObjectURL(url), 15000);

  showToast(
    failed
      ? `Zipped ${files.length}/${list.length} (${failed} failed)`
      : `Zipped ${files.length} items`,
    { duration: 2600, icon: CHECK_ICON }
  );
}


module.exports.makeZipBlob = makeZipBlob;
module.exports.buildZipDownload = buildZipDownload;
});


defineModule("features/media-downloader/dm-thread-api.js", function (module, exports, require) {
/**
 * Shared private-API access for DM threads.
 *
 * Both the voice-note and the photo-attachment downloaders need to read the
 * current thread's items from Instagram's private REST API to recover the
 * original media (the rendered DOM only carries downscaled/transformed URLs, and
 * voice .ogg urls aren't in the DOM at all). The content script shares the
 * instagram.com origin, so a credentialed same-origin fetch to /api/v1/* is
 * authenticated by cookies and isn't blocked by CORS.
 *
 * This module owns the generic plumbing: CSRF, the JSON GET, mapping the URL's
 * thread id to the canonical thread id (via the inbox), and pulling thread items.
 */

var { IG_APP_ID } = require("features/media-downloader/config.js");

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function igGetJson(path) {
  const res = await fetch("https://www.instagram.com" + path, {
    method: "GET",
    credentials: "include",
    headers: {
      "X-IG-App-ID": IG_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": csrfToken(),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " — GET " + path);
  return res.json();
}

// --- thread id resolution (URL id -> canonical thread id, via the inbox) ------

const canonicalByUrlId = new Map();

function currentThreadUrlId() {
  const m = location.pathname.match(/\/direct\/t\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function resolveCanonicalId(urlId) {
  if (!urlId) return null;
  if (canonicalByUrlId.has(urlId)) return canonicalByUrlId.get(urlId);
  try {
    const inbox = await igGetJson(
      "/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&thread_message_limit=1&persistentBadging=true&limit=20"
    );
    const threads = (inbox && inbox.inbox && inbox.inbox.threads) || [];
    for (const t of threads) {
      const cid = String(t.thread_id || t.thread_v2_id || "");
      if (!cid) continue;
      [t.thread_id, t.thread_v2_id, t.thread_fbid].forEach((k) => {
        if (k != null) canonicalByUrlId.set(String(k), cid);
      });
      (t.users || []).forEach((u) => {
        [u.pk, u.fbid, u.id, u.interop_messaging_user_fbid].forEach((k) => {
          if (k != null) canonicalByUrlId.set(String(k), cid);
        });
      });
    }
    if (canonicalByUrlId.has(urlId)) return canonicalByUrlId.get(urlId);
    const pick = threads.find((t) => JSON.stringify(t).indexOf(urlId) !== -1);
    const id = pick && String(pick.thread_id || pick.thread_v2_id || "");
    if (id) {
      canonicalByUrlId.set(urlId, id);
      return id;
    }
  } catch (_) {
    /* fall through */
  }
  // Last resort: many threads' URL id already IS the canonical id.
  return urlId;
}

/**
 * Fetch up to `maxPages` pages of the current thread's items (newest first,
 * paginating older). Returns a flat array of thread items, or [] on failure.
 */
async function fetchThreadItems(maxPages = 1) {
  const urlId = currentThreadUrlId();
  if (!urlId) return [];
  const canonicalId = await resolveCanonicalId(urlId);
  if (!canonicalId) return [];

  const out = [];
  let cursor = null;
  let pages = 0;
  do {
    const q =
      "/api/v1/direct_v2/threads/" +
      canonicalId +
      "/?visual_message_return_type=unseen&limit=50" +
      (cursor
        ? "&cursor=" + encodeURIComponent(cursor) + "&direction=older"
        : "");
    let json;
    try {
      json = await igGetJson(q);
    } catch (_) {
      break;
    }
    const thread = json && json.thread;
    const items = (thread && thread.items) || [];
    out.push(...items);
    cursor =
      thread && thread.has_older
        ? thread.oldest_cursor || thread.prev_cursor
        : null;
    pages++;
  } while (cursor && pages < maxPages);

  return out;
}


module.exports.igGetJson = igGetJson;
module.exports.currentThreadUrlId = currentThreadUrlId;
module.exports.resolveCanonicalId = resolveCanonicalId;
module.exports.fetchThreadItems = fetchThreadItems;
});


defineModule("features/media-downloader/config.js", function (module, exports, require) {
/**
 * Media Downloader — shared configuration & constants.
 *
 * One self-contained feature folder that adds "download" affordances all over
 * Instagram web: posts (incl. carousels), reels, stories, profile pictures and
 * DM voice messages. Everything resolves the *highest quality* source straight
 * from Instagram's own private web API (the same `X-IG-App-ID` credentialed
 * endpoints the rest of the extension already uses) and hands the final CDN URL
 * to the background service worker, which saves it via `chrome.downloads` — that
 * path is CORS-free and forces a real "Save" with a sensible filename.
 */

// Instagram's public web App-ID. Used by every other feature in this extension
// (follow-analyzer, profile-pic-popup, …) for credentialed private-API calls.
const IG_APP_ID = "936619743392459";
const IG_ASBD_ID = "129477";

// chrome.runtime message type the background worker listens for.
const DOWNLOAD_MSG = "INSTAFN_DOWNLOAD";

// Settings keys owned by this feature. The master switch gates everything; the
// per-surface toggles decide where buttons appear.
const SETTINGS_KEYS = {
  master: "enableMediaDownloader",
  posts: "downloadOnPosts",
  reels: "downloadOnReels",
  stories: "downloadOnStories",
  profilePics: "downloadProfilePictures",
  audio: "downloadAudioMessages",
  chatImages: "downloadChatImages",
  askLocation: "downloadAskLocation",
  askQuality: "downloadAskQuality",
  embedMetadata: "downloadEmbedMetadata",
};

// Defaults for the keys above. Mirrored into settings.js / content.js /
// background.js default blocks (kept in sync by hand, like every other feature).
const DOWNLOAD_DEFAULTS = {
  [SETTINGS_KEYS.master]: false,
  [SETTINGS_KEYS.posts]: true,
  [SETTINGS_KEYS.reels]: true,
  [SETTINGS_KEYS.stories]: true,
  [SETTINGS_KEYS.profilePics]: true,
  [SETTINGS_KEYS.audio]: true,
  [SETTINGS_KEYS.chatImages]: true,
  [SETTINGS_KEYS.askLocation]: false,
  [SETTINGS_KEYS.askQuality]: false,
  [SETTINGS_KEYS.embedMetadata]: true,
};

// Attribute stamped on every element we've already processed so re-scans (from
// the MutationObserver / interval / url-change) are cheap idempotent no-ops.
const PROCESSED_ATTR = "data-instafn-dl";

// Marker class on our injected buttons (used for cleanup when disabling).
const BUTTON_CLASS = "instafn-dl-btn";


module.exports.IG_APP_ID = IG_APP_ID;
module.exports.IG_ASBD_ID = IG_ASBD_ID;
module.exports.DOWNLOAD_MSG = DOWNLOAD_MSG;
module.exports.SETTINGS_KEYS = SETTINGS_KEYS;
module.exports.DOWNLOAD_DEFAULTS = DOWNLOAD_DEFAULTS;
module.exports.PROCESSED_ATTR = PROCESSED_ATTR;
module.exports.BUTTON_CLASS = BUTTON_CLASS;
});


defineModule("features/media-downloader/ui.js", function (module, exports, require) {
/**
 * Shared UI helpers for the download buttons.
 *
 * Buttons are intentionally minimal DOM (a <button> with an inline SVG) and
 * styled via media-downloader.css. They carry a spinner state so the user gets
 * feedback while the private-API resolve + save is in flight.
 */

var { BUTTON_CLASS, PROCESSED_ATTR } = require("features/media-downloader/config.js");

// Download glyph (tray + down arrow). Uses currentColor so it inherits whatever
// the surrounding IG control color is.
const DOWNLOAD_SVG = `
<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3v12"></path>
  <path d="M7 11l5 5 5-5"></path>
  <path d="M4 20h16"></path>
</svg>`;

const SPINNER_SVG = `
<svg viewBox="0 0 24 24" width="24" height="24" class="instafn-dl-spin" aria-hidden="true">
  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-dasharray="44" stroke-dashoffset="14"></circle>
</svg>`;

/**
 * Create a download button.
 * @param {Object} opts
 * @param {Function} opts.onClick async handler (button enters spinner state until it resolves)
 * @param {string}   [opts.title] tooltip / aria-label
 * @param {string}   [opts.variant] extra class for surface-specific styling
 * @param {number}   [opts.size] icon px size (default 24)
 */
function createDownloadButton({ onClick, title = "Download", variant = "", size = 24 } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `${BUTTON_CLASS} ${variant}`.trim();
  btn.setAttribute("aria-label", title);
  btn.title = title;
  btn.innerHTML = DOWNLOAD_SVG;
  btn.setAttribute(PROCESSED_ATTR, "1");
  if (size !== 24) {
    const svg = btn.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
    }
  }

  let busy = false;
  const setBusy = (b) => {
    busy = b;
    btn.classList.toggle("instafn-dl-busy", b);
    btn.innerHTML = b ? SPINNER_SVG : DOWNLOAD_SVG;
    // Re-apply the custom size to BOTH glyphs (the spinner SVG also ships at 24),
    // so the loading icon matches the download icon instead of jumping larger.
    if (size !== 24) {
      const svg = btn.querySelector("svg");
      if (svg) {
        svg.setAttribute("width", String(size));
        svg.setAttribute("height", String(size));
      }
    }
  };

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onClick(e);
    } catch (err) {
      console.error("[Instafn] download button error:", err);
    } finally {
      setBusy(false);
    }
  });

  // Stop IG's own handlers (post-open, like, etc.) from firing on our button.
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());

  return btn;
}

/** Has this element already been given a download button by us? */
function alreadyProcessed(el) {
  return !el || el.getAttribute(PROCESSED_ATTR) === "1";
}

function markProcessed(el) {
  if (el) el.setAttribute(PROCESSED_ATTR, "1");
}


module.exports.createDownloadButton = createDownloadButton;
module.exports.alreadyProcessed = alreadyProcessed;
module.exports.markProcessed = markProcessed;
});


defineModule("features/media-downloader/inject-stories.js", function (module, exports, require) {
/**
 * Story / highlight download button.
 *
 * Injected like the "Mark as seen" button: scope to the story reply bar (the row
 * with the Like + Send buttons), clone the *bare Send button* and drop the clone
 * in right before Send. Cloning only the send button (not the whole row-item)
 * matters — the row-item is the [Like][Send] cluster, and cloning that left an
 * intact Send icon inside our copy, which the next scan re-matched and re-cloned
 * (runaway duplicate buttons). A bare clone has its single icon fully swapped to
 * the download glyph and every aria-label rewritten, so nothing re-matches it.
 *
 * Only one story is ever open, so we keep exactly one button document-wide and
 * resolve the media id from the /stories/.../<id>/ URL at CLICK time — which also
 * means the single persistent button always targets the story currently on
 * screen as you tap through, with no re-injection needed.
 */

var { resolveMediaById } = require("features/media-downloader/ig-api.js");
var { resolveVisibleStory } = require("features/media-downloader/story-source.js");
var { runDownload } = require("features/media-downloader/downloader.js");
var { findSendButton, injectDownloadBeforeSend, ITEM_CLASS } = require("features/media-downloader/inject-common.js");

const STORY_SELECTOR = `.${ITEM_CLASS}[data-dl-surface="story"]`;

// Last numeric segment of a /stories/... path — the media id for regular
// stories. Often absent on the FIRST story of a tray (the URL is just
// /stories/{username}/ until you navigate), and on highlights it's the reel id,
// not a media pk — so this is only the fast path, backed by the tray resolver.
function storyMediaIdFromUrl() {
  if (!location.pathname.startsWith("/stories/")) return null;
  if (location.pathname.startsWith("/stories/highlights/")) return null;
  const nums = location.pathname.match(/\d{6,}/g);
  return nums ? nums[nums.length - 1] : null;
}

// Resolve the on-screen story: try the URL's media id first (fast, no extra
// request), then fall back to the reel-tray API matched to the visible media —
// which works even when the URL has no pk yet (first story) or is a highlight.
async function resolveStory() {
  const id = storyMediaIdFromUrl();
  if (id) {
    try {
      const list = await resolveMediaById(id);
      if (list && list.length) return list;
    } catch (_) {
      /* fall through to the tray resolver */
    }
  }
  return resolveVisibleStory();
}

function isStoryContext() {
  if (location.pathname.startsWith("/stories/")) return true;
  const hasReply = !!document.querySelector('textarea[placeholder*="Reply to"]');
  const hasDialog =
    !!document.querySelector('[role="dialog"]') ||
    !!document.querySelector('article[role="presentation"]');
  return hasReply && hasDialog;
}

// The open story viewer (dialog on desktop, presentation article on the
// /stories/ route).
function storyViewer() {
  return (
    document.querySelector('[role="dialog"]') ||
    document.querySelector('article[role="presentation"]') ||
    null
  );
}

// Where to anchor the button. Prefer the reply bar: climb from the viewer's
// reply textarea (language-agnostic — the story viewer has only the one) to the
// nearest ancestor that also holds the Send/Direct button. Fall back to the
// viewer itself when there's no reply box but it carries a Send/Share control.
function findReplyBar() {
  const viewer = storyViewer();
  const reply = (viewer || document).querySelector("textarea");
  if (reply) {
    let node = reply;
    for (let i = 0; i < 8 && node; i++) {
      if (findSendButton(node)) return node;
      node = node.parentElement;
    }
  }
  return viewer && findSendButton(viewer) ? viewer : null;
}

function injectStoryButton() {
  if (!isStoryContext()) {
    removeStoryButton();
    return;
  }

  const bar = findReplyBar();
  const sendBtn = bar ? findSendButton(bar) : null;
  if (!sendBtn) return; // no anchor on this story (e.g. own story without share)

  // Self-heal across navigation: IG re-renders the reply bar per story, so a
  // single persistent button goes stale (this is why a "keep the first one"
  // guard left ONLY the first story with a button). Keep our button only if it
  // already lives in the CURRENT story's bar; otherwise drop any strays and
  // re-inject into this story.
  const existing = document.querySelector(STORY_SELECTOR);
  if (existing && bar.contains(existing)) return;
  removeStoryButton();

  // No `row` arg → clone the bare Send button (single icon, fully relabeled).
  injectDownloadBeforeSend(sendBtn, {
    label: "Download story",
    surface: "story",
    onClick: () => runDownload(resolveStory, "story"),
  });
}

function removeStoryButton() {
  document.querySelectorAll(STORY_SELECTOR).forEach((el) => el.remove());
}


module.exports.injectStoryButton = injectStoryButton;
module.exports.removeStoryButton = removeStoryButton;
});


defineModule("features/media-downloader/story-source.js", function (module, exports, require) {
/**
 * Robust story-media resolution.
 *
 * The story download button used to derive the media id purely from the URL's
 * trailing number. That breaks on the FIRST story of a tray: Instagram often
 * shows it at `/stories/{username}/` before it has written the media pk into the
 * URL, so there's no id to resolve until you navigate to another story and back.
 *
 * This resolver doesn't depend on the URL carrying a pk. It pulls the user's (or
 * highlight's) reel tray from the private API — which returns every story item
 * with its full media — and matches the item that's actually on screen by the
 * CDN media token of the visible <img>/<video> (the same token trick used for DM
 * images and post carousels). Used as a fallback when the URL has no usable id.
 */

var { igGetJson, itemToMediaList } = require("features/media-downloader/ig-api.js");

// The long numeric id in a CDN media filename, shared across renditions.
function mediaToken(url) {
  try {
    const file = new URL(url, location.href).pathname.split("/").pop() || "";
    const m = file.match(/\d{10,}/);
    return m ? m[0] : "";
  } catch (_) {
    return "";
  }
}

// What kind of story page we're on: a user tray (needs the user's id) or a
// highlight reel (the URL already carries the reel id).
function storyUrlInfo() {
  const hl = location.pathname.match(/^\/stories\/highlights\/(\d+)/);
  if (hl) return { reelId: `highlight:${hl[1]}` };
  const u = location.pathname.match(/^\/stories\/([^/?#]+)/);
  if (u && u[1] !== "highlights") return { username: u[1] };
  return {};
}

const userIdByName = new Map();
async function userIdFor(username) {
  if (userIdByName.has(username)) return userIdByName.get(username);
  try {
    const d = await igGetJson(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
        username
      )}`
    );
    const id = d?.data?.user?.id || d?.data?.user?.pk || null;
    const sid = id ? String(id) : null;
    userIdByName.set(username, sid);
    return sid;
  } catch (_) {
    return null;
  }
}

// reels_media responses come in two shapes: an array (`reels_media`) or a map
// keyed by reel id (`reels`). Return the first reel's items from whichever.
function reelItems(json, reelId) {
  const arr = json?.reels_media;
  if (Array.isArray(arr)) {
    for (const r of arr) if (Array.isArray(r?.items) && r.items.length) return r.items;
  }
  const map = json?.reels;
  if (map) {
    const r = map[reelId] || Object.values(map)[0];
    if (Array.isArray(r?.items)) return r.items;
  }
  return [];
}

// CDN media tokens present anywhere on the page, ordered by the on-screen size
// of the element they came from (largest first). VIDEO stories are the hard
// case: the <video> src is a blob: URL with no token, and its cover image may be
// hidden/small/off-centre — so we scan EVERY <img>/<video> source (src,
// currentSrc, poster, srcset, <source> children), no size/position filter, and
// just rank by area so the active story's media wins the match. Matching stays
// exact (token must appear in the item's own URLs), so a wider net can't pick
// the wrong story — only find one we'd otherwise have missed.
function urlToken(s) {
  return mediaToken(s || "");
}

function rankedStoryTokens() {
  const found = []; // { token, area }
  const add = (url, area) => {
    const t = urlToken(url);
    if (t) found.push({ token: t, area });
  };
  for (const el of document.querySelectorAll("img, video")) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    add(el.currentSrc, area);
    add(el.src, area);
    add(el.poster, area);
    if (el.srcset) {
      for (const part of el.srcset.split(",")) {
        add(part.trim().split(/\s+/)[0], area);
      }
    }
    if (el.tagName === "VIDEO") {
      el.querySelectorAll("source").forEach((s) =>
        add(s.src || s.getAttribute("src"), area)
      );
    }
  }
  found.sort((a, b) => b.area - a.area);
  const seen = new Set();
  const out = [];
  for (const f of found) {
    if (!seen.has(f.token)) {
      seen.add(f.token);
      out.push(f.token);
    }
  }
  return out;
}

/**
 * Resolve the story currently on screen to a download list, independent of the
 * URL. Returns [] when the tray can't be fetched or the visible item can't be
 * identified (caller falls back / reports nothing found).
 */
async function resolveVisibleStory() {
  const { username, reelId } = storyUrlInfo();
  let rid = reelId;
  if (!rid && username) rid = await userIdFor(username);
  if (!rid) return [];

  let json;
  try {
    json = await igGetJson(
      `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(
        rid
      )}`
    );
  } catch (_) {
    return [];
  }

  const items = reelItems(json, rid);
  if (!items.length) return [];

  // Match the on-screen story by its media token; tokens are ranked by element
  // size so the largest (active) story's token is tried first. Exact match only,
  // so we never silently grab the wrong story.
  const tokens = rankedStoryTokens();
  let item = null;
  for (const t of tokens) {
    item = items.find((it) => JSON.stringify(it).includes(t));
    if (item) break;
  }
  if (!item) {
    // Leave a breadcrumb so a miss is diagnosable instead of silent.
    console.debug(
      `[instafn] story media match failed — ${tokens.length} page tokens vs ${items.length} tray items`,
      tokens
    );
    return [];
  }
  return itemToMediaList(item);
}


module.exports.resolveVisibleStory = resolveVisibleStory;
});


defineModule("features/media-downloader/inject-profile-pic.js", function (module, exports, require) {
/**
 * Profile picture download — the avatar in a profile header.
 *
 * Instagram only renders a downscaled avatar in the DOM, so we never download
 * the <img> src directly. Instead the button resolves the true HD square via the
 * private user-info endpoints (ig-api.resolveProfilePicture).
 *
 * The button is an overlay anchored to the avatar's container, revealed on hover
 * (see media-downloader.css). It coexists with the long-press Profile Picture
 * Popup feature — different gesture, different control.
 */

var { createDownloadButton } = require("features/media-downloader/ui.js");
var { BUTTON_CLASS } = require("features/media-downloader/config.js");
var { resolveProfilePicture } = require("features/media-downloader/ig-api.js");
var { runDownload } = require("features/media-downloader/downloader.js");

const FLAG = "data-instafn-dl-pfp";

function profileUsername() {
  const m = location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
  return m ? m[1] : null;
}

function findAvatarImg() {
  const header = document.querySelector("header");
  if (!header) return null;
  const imgs = header.querySelectorAll("img");
  for (const img of imgs) {
    if (/profile picture/i.test(img.alt || "")) return img;
  }
  return null;
}

// Pick the box to anchor the overlay on: the smallest ancestor that still
// tightly bounds the avatar but does NOT clip its overflow. When the user has
// an active story, IG nests the avatar inside an extra circular, overflow-hidden
// ring container — anchoring on that clip box would cut off the corner button,
// so we step out to the first non-clipping ancestor instead.
function pickAnchor(img) {
  const imgRect = img.getBoundingClientRect();
  let el = img.parentElement;
  while (el && el !== document.body) {
    const rect = el.getBoundingClientRect();
    // Past ~1.8x the avatar we'd be anchoring on page chrome, not the avatar.
    if (rect.width > imgRect.width * 1.8) break;
    const cs = getComputedStyle(el);
    const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
    if (!clips && rect.width >= imgRect.width - 1) return el;
    el = el.parentElement;
  }
  return img.closest("span, div");
}

function injectProfilePicButton() {
  const username = profileUsername();
  if (!username) return;

  const img = findAvatarImg();
  if (!img) return;

  const anchor = pickAnchor(img);
  if (!anchor || anchor.getAttribute(FLAG) === username) return;
  if (anchor.querySelector(`.${BUTTON_CLASS}`)) {
    anchor.setAttribute(FLAG, username);
    return;
  }

  // Reveal-on-hover hook + positioning context for the overlay.
  anchor.classList.add("instafn-dl-pfp-anchor");
  const pos = getComputedStyle(anchor).position;
  if (pos === "static") anchor.style.position = "relative";

  const btn = createDownloadButton({
    title: "Download profile picture",
    variant: "instafn-dl-pfp",
    size: 18,
    onClick: async () => {
      const media = await resolveProfilePicture(username);
      return runDownload(async () => (media ? [media] : []), "profile picture");
    },
  });

  const wrapper = document.createElement("div");
  wrapper.className = "instafn-dl-pfp-wrap";
  wrapper.appendChild(btn);
  anchor.appendChild(wrapper);

  anchor.setAttribute(FLAG, username);
}

function removeProfilePicButton() {
  document.querySelectorAll(`[${FLAG}]`).forEach((el) => {
    el.removeAttribute(FLAG);
    el.classList.remove("instafn-dl-pfp-anchor");
  });
  document.querySelectorAll(".instafn-dl-pfp-wrap").forEach((el) => el.remove());
}


module.exports.injectProfilePicButton = injectProfilePicButton;
module.exports.removeProfilePicButton = removeProfilePicButton;
});


defineModule("features/media-downloader/ig-api.js", function (module, exports, require) {
/**
 * Private-API media resolution.
 *
 * All of these run from the content script's isolated world, which shares the
 * instagram.com origin — so a credentialed same-origin `fetch` to /api/v1/* is
 * authenticated automatically (cookies) and not blocked by CORS. This is the
 * exact pattern follow-analyzer/logic.js and profile-pic-popup use.
 *
 * The endpoints used here return the FULL candidate ladder for every piece of
 * media, so we can always pick the largest rendition (true "highest quality"),
 * rather than the downscaled version Instagram happens to render in the DOM.
 */

var { IG_APP_ID, IG_ASBD_ID } = require("features/media-downloader/config.js");
var { extractMetadata, profileMetadata } = require("features/media-downloader/metadata.js");

// IG shortcodes are base64url-encoded media ids over this exact alphabet.
// (Same table used by post-hover-info to derive post dates from shortcodes.)
const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// A media pk is a 64-bit integer, so its canonical shortcode is at most 11
// base64 chars (ceil(64/6)). Instagram's newer "extended" share links
// (/p/<code>/ where <code> is much longer) append a share/tracking token after
// the real shortcode — decoding the whole string overflows into a nonexistent
// id and the info endpoint 400s. Only the leading 11 chars carry the pk.
const MAX_SHORTCODE_LEN = 11;

/** Decode an Instagram shortcode (e.g. from /p/<code>/) to its numeric media id. */
function shortcodeToMediaId(shortcode) {
  if (!shortcode) return null;
  const code = shortcode.slice(0, MAX_SHORTCODE_LEN);
  let id = 0n;
  for (let i = 0; i < code.length; i++) {
    const v = SHORTCODE_ALPHABET.indexOf(code[i]);
    if (v === -1) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

/** Pull a /p/<code>/, /reel/<code>/ or /tv/<code>/ shortcode out of any href/url. */
function extractShortcode(href) {
  if (!href) return null;
  const m = href.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/);
  return m ? m[1] : null;
}

function csrfToken() {
  const m = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function igHeaders() {
  const headers = {
    Accept: "application/json",
    "X-IG-App-ID": IG_APP_ID,
    "X-ASBD-ID": IG_ASBD_ID,
    "X-IG-WWW-Claim": "0",
    "X-Requested-With": "XMLHttpRequest",
  };
  const token = csrfToken();
  if (token) headers["X-CSRFToken"] = token;
  return headers;
}

async function igGetJson(url) {
  const resp = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: igHeaders(),
  });
  if (!resp.ok) {
    if (resp.status === 429) {
      throw new Error("Rate limited by Instagram (HTTP 429). Try again later.");
    }
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Rendition picking.
//
// Each media node ships a *ladder* of renditions (the same photo/video at
// several resolutions). We always expose the full ladder, sorted largest-first,
// as `candidates: [{url, width, height}]`. The descriptor's own `url` is set to
// the largest — so the default path (no quality prompt) saves highest quality.
// The "Ask for Quality" flow lets the user pick a different rung off `candidates`.
// ---------------------------------------------------------------------------

// Sort a list of {url, width, height}-ish entries by pixel area, largest first.
function byAreaDesc(list) {
  return [...list].sort(
    (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
  );
}

// Normalize a raw rendition list (video_versions / image candidates / profile
// pic versions) into sorted {url, width, height} entries, dropping urlless ones.
function toCandidates(list) {
  if (!Array.isArray(list) || !list.length) return [];
  return byAreaDesc(list)
    .filter((v) => v && v.url)
    .map((v) => ({ url: v.url, width: v.width || 0, height: v.height || 0 }));
}

function videoCandidates(node) {
  return toCandidates(node?.video_versions);
}

function imageCandidates(node) {
  return toCandidates(
    node?.image_versions2?.candidates || node?.image_versions?.candidates || []
  );
}

// Turn a single media "node" (a post item, a carousel child, or a story item)
// into a normalized download descriptor. Videos win over images when both
// exist (a video post still ships a poster image we don't want).
function nodeToMedia(node, meta) {
  const videos = videoCandidates(node);
  if (videos.length) {
    return { type: "video", url: videos[0].url, candidates: videos, ...meta };
  }
  const images = imageCandidates(node);
  if (images.length) {
    return { type: "image", url: images[0].url, candidates: images, ...meta };
  }
  return null;
}

// Expand a top-level media item into one-or-many download descriptors,
// flattening carousels (sidecars) into one entry per child.
function itemToMediaList(item) {
  if (!item) return [];
  const username = item.user?.username || item.owner?.username || "instagram";
  const code = item.code || "";
  const children = item.carousel_media;

  if (Array.isArray(children) && children.length) {
    const total = children.length;
    return children
      .map((child, i) =>
        nodeToMedia(child, {
          username,
          code,
          id: child.pk || child.id || item.pk,
          index: i + 1,
          total,
          // Carousel slides carry their own alt text; caption/user/location/date
          // live on the parent item. extractMetadata merges both.
          metadata: extractMetadata(item, child, { code, username }),
        })
      )
      .filter(Boolean);
  }

  const media = nodeToMedia(item, {
    username,
    code,
    id: item.pk || item.id,
    index: 1,
    total: 1,
    metadata: extractMetadata(item, null, { code, username }),
  });
  return media ? [media] : [];
}

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

/**
 * Fetch the full media object for a numeric media id and return a flat list of
 * downloadable renditions (1 entry, or N for a carousel). Works for feed posts,
 * reels AND stories — they all share the /media/<id>/info/ shape.
 */
async function resolveMediaById(mediaId) {
  if (!mediaId) return [];
  const data = await igGetJson(
    `https://www.instagram.com/api/v1/media/${mediaId}/info/`
  );
  const item = data?.items?.[0];
  return itemToMediaList(item);
}

/** Resolve a post/reel by its shortcode (the common feed/permalink/grid case). */
async function resolveByShortcode(shortcode) {
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) return [];
  const list = await resolveMediaById(mediaId);
  // Ensure the shortcode is on every entry for nice filenames even if the API
  // omitted `code` (it usually doesn't).
  return list.map((m) => ({ ...m, code: m.code || shortcode }));
}

/**
 * Resolve the highest-resolution profile picture for a username.
 * Tries the user-info endpoint first (it exposes `hd_profile_pic_url_info`,
 * the largest square IG stores), then falls back to web_profile_info's
 * `profile_pic_url_hd`.
 */
async function resolveProfilePicture(username) {
  if (!username) return null;
  // 1) web_profile_info gives us the user id + a solid HD url.
  let userId = null;
  let hdUrl = null;
  let fullName = "";
  let candidates = [];
  try {
    const data = await igGetJson(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
        username
      )}`
    );
    const user = data?.data?.user;
    if (user) {
      userId = user.id || user.pk;
      hdUrl = user.profile_pic_url_hd || user.profile_pic_url || null;
      fullName = user.full_name || "";
    }
  } catch (_) {}

  // 2) users/<id>/info/ exposes the full square ladder (hd_profile_pic_versions)
  // and often an even larger square (hd_profile_pic_url_info). Best effort.
  if (userId) {
    try {
      const info = await igGetJson(
        `https://www.instagram.com/api/v1/users/${userId}/info/`
      );
      const u = info?.user;
      const ladder = [...(u?.hd_profile_pic_versions || [])];
      if (u?.hd_profile_pic_url_info?.url) {
        ladder.push(u.hd_profile_pic_url_info);
      }
      candidates = toCandidates(ladder);
      if (candidates.length) hdUrl = candidates[0].url;
    } catch (_) {}
  }

  if (!hdUrl) return null;
  // Always carry the largest as a candidate so the quality flow has at least the
  // single HD rung when the info endpoint didn't return a ladder.
  if (!candidates.length) candidates = [{ url: hdUrl, width: 0, height: 0 }];
  return {
    type: "image",
    url: hdUrl,
    candidates,
    username,
    code: "profile",
    index: 1,
    total: 1,
    metadata: profileMetadata(username, fullName),
  };
}


module.exports.shortcodeToMediaId = shortcodeToMediaId;
module.exports.extractShortcode = extractShortcode;
module.exports.igGetJson = igGetJson;
module.exports.itemToMediaList = itemToMediaList;
module.exports.resolveMediaById = resolveMediaById;
module.exports.resolveByShortcode = resolveByShortcode;
module.exports.resolveProfilePicture = resolveProfilePicture;
});


defineModule("features/media-downloader/inject-common.js", function (module, exports, require) {
/**
 * Shared placement for action-bar download buttons.
 *
 * The reliable way to add an action icon that lines up perfectly with IG's own
 * (and never breaks the flex row or disturbs the count numbers) is to CLONE the
 * send / paper-plane button and insert the clone right before it, in the send
 * button's own parent — exactly how story-blocking's "Mark as seen" button
 * clones the heart. The clone is a structurally identical sibling, so it
 * inherits IG's box model, sizing and spacing 1:1. cloneNode() does not copy
 * React's event wiring (no fiber on the clone), so it carries none of Share's
 * behaviour — we attach our own handler.
 */

const ITEM_CLASS = "instafn-dl-item";

// The paper-plane "send" control across surfaces. Prefix matches cover the label
// variants IG ships ("Share", "Share Post", "Send message", "Direct").
const SEND_SELECTOR =
  'svg[aria-label^="Share"], svg[aria-label^="Send"], svg[aria-label="Direct"]';

// Download glyph (tray + down arrow), stroked with currentColor to match IG's
// outline icons (Share / Save / More).
const DOWNLOAD_ICON_PATHS =
  '<path d="M12 3v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
  '<path d="M7 11l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
  '<path d="M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>';

// Modern single-arc spinner — the same one the voice-download button shows
// (ui.js SPINNER_SVG): a 3/4 ring (stroke-dasharray gap) that spins. viewBox
// 0 0 24 24 matches the download glyph, so swapping is a clean in-place change.
const SPINNER_ARC =
  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="44" stroke-dashoffset="14"></circle>';

/**
 * Toggle a download button between its glyph and IG's loading spinner. Stashes
 * each svg's original viewBox / contents / inline styles on the way in and
 * restores them on the way out, so it works for any cloned button shape. The
 * `instafn-dl-spin` keyframes come from media-downloader.css (loaded with the
 * feature, before any click).
 */
function setButtonLoading(item, on) {
  const svgs = item?.querySelectorAll?.("svg");
  if (!svgs || !svgs.length) return;
  svgs.forEach((svg) => {
    if (on) {
      if (svg.dataset.dlBusy === "1") return;
      svg.dataset.dlBusy = "1";
      svg.dataset.dlVb = svg.getAttribute("viewBox") || "";
      svg.dataset.dlInner = svg.innerHTML;
      svg.dataset.dlCss = svg.style.cssText;
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.style.fill = "none";
      svg.style.stroke = "currentColor";
      svg.style.transformOrigin = "center";
      svg.style.animation = "instafn-dl-spin 0.7s linear infinite";
      svg.innerHTML = SPINNER_ARC;
    } else if (svg.dataset.dlBusy === "1") {
      svg.setAttribute("viewBox", svg.dataset.dlVb);
      svg.innerHTML = svg.dataset.dlInner;
      svg.style.cssText = svg.dataset.dlCss;
      delete svg.dataset.dlBusy;
      delete svg.dataset.dlVb;
      delete svg.dataset.dlInner;
      delete svg.dataset.dlCss;
    }
  });
}

/** The send/paper-plane action button inside `container`, or null. */
function findSendButton(container) {
  const svg = container?.querySelector?.(SEND_SELECTOR);
  return svg ? svg.closest('[role="button"], button') : null;
}

/** Lowest common ancestor of two nodes. */
function commonAncestor(a, b) {
  if (!a || !b) return null;
  const seen = new Set();
  for (let n = a; n; n = n.parentElement) seen.add(n);
  for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
  return null;
}

// The "row item" for `btn` within `row`: the ancestor of `btn` that sits as a
// direct child of `row`. On the reels rail each action is wrapped in its own
// spacing container (a direct child of the rail); on the post action bar the
// button itself is the direct child. Cloning at THIS level — not the bare
// button — is what makes the new item pick up the rail's gap/margins and line
// up with its neighbours.
function rowItem(row, btn) {
  let node = btn;
  while (node && node.parentElement && node.parentElement !== row) {
    node = node.parentElement;
  }
  return node && node.parentElement === row ? node : btn;
}

// Turn a cloned send button into a download control: swap the glyph, relabel
// every aria-label so screen readers don't announce "Share", neutralise the
// liked/active colour, and wire our async handler with a busy state.
function makeDownloadFromClone(item, { label, onClick, surface }) {
  item.removeAttribute("id");
  item.classList.add(ITEM_CLASS);
  item.setAttribute("data-instafn-dl-injected", "1");
  if (surface) item.setAttribute("data-dl-surface", surface);
  item.setAttribute("aria-label", label);
  item.title = label;
  item.style.cursor = "pointer";

  // Swap EVERY svg in the clone, not just the first. Some action items (notably
  // the post-lightbox Share button) carry more than one svg — swapping only the
  // first left the visible paper-plane intact, so the download button rendered
  // as a Share icon even though it worked.
  item.querySelectorAll("svg").forEach((svg) => {
    svg.setAttribute("aria-label", label);
    svg.setAttribute("role", "img");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("height", "24");
    svg.setAttribute("width", "24");
    svg.innerHTML = DOWNLOAD_ICON_PATHS;
    svg.style.fill = "none";
    svg.style.stroke = "currentColor";
    svg.style.color = "currentColor";
  });
  // Relabel every aria-labelled node so nothing still reads as "Share"/"Direct"
  // (which would let a re-scan re-match and re-clone our own button).
  item
    .querySelectorAll("[aria-label]")
    .forEach((el) => el.setAttribute("aria-label", label));

  let busy = false;
  const handler = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    busy = true;
    setButtonLoading(item, true);
    try {
      await onClick();
    } finally {
      busy = false;
      setButtonLoading(item, false);
    }
  };
  // Capture so we beat any residual delegated handlers.
  item.addEventListener("click", handler, true);
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") handler(e);
  });

  return item;
}

/** Clone `templateEl` (an action button / its row-item) into a download control. */
function buildDownloadClone(templateEl, opts) {
  return makeDownloadFromClone(templateEl.cloneNode(true), opts);
}

/**
 * Clone the Send button's row-item into a download button and insert it right
 * before that item (second-to-last action), inside `row`.
 *
 * `row` is the action bar / rail container. When omitted we fall back to the
 * send button's own parent and clone the bare button (correct for layouts where
 * actions are direct children, e.g. the post action bar).
 *
 * Returns the inserted element, or null.
 */
function injectDownloadBeforeSend(sendBtn, row, opts) {
  if (!sendBtn) return null;
  // Allow (sendBtn, opts) — when the second arg isn't a DOM node it's the opts.
  if (row && row.nodeType !== 1) {
    opts = row;
    row = null;
  }
  const container = row || sendBtn.parentNode;
  if (!container) return null;
  const template = row ? rowItem(row, sendBtn) : sendBtn;
  const item = makeDownloadFromClone(template.cloneNode(true), opts);
  container.insertBefore(item, template);
  return item;
}


module.exports.ITEM_CLASS = ITEM_CLASS;
module.exports.SEND_SELECTOR = SEND_SELECTOR;
module.exports.setButtonLoading = setButtonLoading;
module.exports.findSendButton = findSendButton;
module.exports.commonAncestor = commonAncestor;
module.exports.rowItem = rowItem;
module.exports.buildDownloadClone = buildDownloadClone;
module.exports.injectDownloadBeforeSend = injectDownloadBeforeSend;
});


defineModule("features/media-downloader/inject-chat-images.js", function (module, exports, require) {
/**
 * Download photo attachments sent in DMs.
 *
 * Adds a download button to Instagram's own on-hover message action row (the
 * React / Reply / More cluster) — but only for plain photo attachments, never
 * for shared posts/reels, link previews, videos or avatars.
 *
 * To match the row's spacing/sizing exactly, we CLONE one of IG's existing
 * button spans (same obfuscated classes → same layout), swap its glyph for the
 * download icon, strip its aria wiring, and wire our own click handler. A cloned
 * node carries no React listeners, so clicking it runs only our code; and it
 * uses a distinct aria-label, so the quick react/reply/edit pipelines (which key
 * off the React/Reply/More aria-labels) are untouched. Appended as the row's
 * LAST child → it lands on the outer edge in both the normal and reversed
 * (messages-you-sent) layouts.
 *
 * Photo URL = the bubble's rendered <img> (IG serves a full-size image there),
 * resolved at CLICK time so a recycled row always targets the current image.
 */

var { downloadMedia, maybePromptQuality } = require("features/media-downloader/downloader.js");
var { showToast, CHECK_ICON } = require("ui/toast.js");
var { resolveFullImage } = require("features/media-downloader/image-source.js");
var { setButtonLoading } = require("features/media-downloader/inject-common.js");

const VARIANT = "instafn-dl-chatimg";
const REACT_SVG = 'svg[aria-label^="React to message"]';

// DM photo bubbles render a *resized* rendition: the fbcdn/cdninstagram URL
// carries an `stp=` transform token (e.g. dst-jpg_e35_s640x640) that caps the
// image at the bubble's display size. The same URL WITHOUT `stp` returns the
// stored original (full resolution). The signature (oh/oe) covers the resource,
// not the transform, so dropping `stp` keeps the URL valid.
function fullResUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, location.href);
    if (!/cdninstagram|fbcdn/i.test(u.hostname)) return rawUrl;
    if (!u.searchParams.has("stp")) return rawUrl;
    u.searchParams.delete("stp");
    return u.toString();
  } catch (_) {
    return rawUrl;
  }
}

// Confirm a candidate URL actually serves before we commit to it — a 1-byte
// range request is cheap and tells us the CDN accepts the un-transformed URL
// (it returns 206/200) without pulling the whole image. cdninstagram/fbcdn are
// in host_permissions and CORS-enabled for images, so this fetch is allowed.
async function urlServes(url) {
  try {
    const resp = await fetch(url, {
      credentials: "omit",
      headers: { Range: "bytes=0-0" },
    });
    return resp.ok; // 200 or 206
  } catch (_) {
    return false;
  }
}

const DL_PATHS =
  '<path d="M12 3v12"></path><path d="M7 11l5 5 5-5"></path><path d="M4 20h16"></path>';

// The downloadable photo for an action row, or null when this message isn't a
// plain photo attachment. A real photo attachment is a CDN <img> that:
//  - sits in the same message-content wrapper as the action bar,
//  - is NOT inside a link (shared posts/reels, link previews and avatars wrap
//    their thumbnail in an <a href>; a plain photo opens a lightbox via
//    role=button, no navigation), and
//  - isn't the poster frame of a video attachment.
function attachmentImageNear(barWrapper) {
  const scope = barWrapper?.parentElement;
  if (!scope) return null;
  if (scope.querySelector("video")) return null; // video attachment, not a photo
  for (const img of scope.querySelectorAll("img")) {
    if (img.closest("a[href]")) continue; // shared post/reel/link/avatar
    const src = img.currentSrc || img.src || "";
    if (!/fbcdn|cdninstagram|fbsbx/i.test(src)) continue;
    const w = img.naturalWidth || parseInt(img.getAttribute("width"), 10) || 0;
    if (w && w < 80) continue; // skip tiny inline glyphs
    return img;
  }
  return null;
}

// Clone an existing action-row button span into our download button (identical
// spacing), swap the glyph, strip aria wiring, and attach our handler.
function buildClone(templateSpan, onClick) {
  const clone = templateSpan.cloneNode(true);
  clone.classList.add(VARIANT);
  clone.removeAttribute("aria-describedby");

  const svg = clone.querySelector("svg");
  if (svg) {
    svg.setAttribute("aria-label", "Download image");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.innerHTML = `<title>Download image</title>${DL_PATHS}`;
  }

  const roleBtn = clone.querySelector('[role="button"]') || clone;
  roleBtn.removeAttribute("aria-haspopup");
  roleBtn.removeAttribute("aria-expanded");
  roleBtn.setAttribute("aria-label", "Download image");
  roleBtn.title = "Download image";

  let busy = false;
  roleBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    busy = true;
    setButtonLoading(clone, true);
    try {
      await onClick();
    } finally {
      busy = false;
      setButtonLoading(clone, false);
    }
  });
  // Keep IG's message handlers (open lightbox, etc.) from firing on our button.
  ["mousedown", "pointerdown"].forEach((t) =>
    roleBtn.addEventListener(t, (e) => e.stopPropagation())
  );

  return clone;
}

function injectForRow(reactSvg) {
  const templateSpan = reactSvg.closest("span");
  const innerRow = templateSpan?.parentElement;
  if (!innerRow) return;
  if (innerRow.querySelector(`.${VARIANT}`)) return; // already added

  const barWrapper = innerRow.parentElement; // div[style*="--x-width: 96px"]
  const img = attachmentImageNear(barWrapper);
  if (!img) return; // not a plain photo attachment — leave the row alone

  const clone = buildClone(templateSpan, async () => {
    const live = attachmentImageNear(barWrapper) || img;
    const rendered = live.currentSrc || live.src || "";
    if (!rendered) {
      showToast("Couldn't find this image.", { duration: 2000 });
      return;
    }
    // Highest quality, in order of reliability:
    //  1) Instagram's DM API (image_versions2 — full ladder; also feeds the
    //     quality picker),
    //  2) the rendered URL with its `stp=` resize transform stripped,
    //  3) the rendered URL as-is.
    const base = {
      type: "image",
      username: "instagram",
      code: "dm_image",
      index: 1,
      total: 1,
    };
    let media = null;
    try {
      const full = await resolveFullImage(rendered);
      if (full?.candidates?.length) {
        media = { ...base, url: full.url, candidates: full.candidates };
      }
    } catch (_) {
      /* fall through to URL heuristics */
    }
    if (!media) {
      const upgraded = fullResUrl(rendered);
      const url =
        upgraded !== rendered && (await urlServes(upgraded))
          ? upgraded
          : rendered;
      media = { ...base, url };
    }

    const picked = await maybePromptQuality([media]);
    if (picked === null) return; // cancelled at the quality prompt
    const ok = await downloadMedia(picked[0]);
    if (ok) showToast("Saved", { duration: 1500, icon: CHECK_ICON });
    else showToast("Couldn't save this image.", { duration: 1500 });
  });

  innerRow.appendChild(clone); // last child → outer edge in both layouts
}

function injectChatImageButtons() {
  if (!location.pathname.startsWith("/direct/")) return;
  document.querySelectorAll(REACT_SVG).forEach(injectForRow);
}

function removeChatImageButtons() {
  document.querySelectorAll(`.${VARIANT}`).forEach((el) => el.remove());
}


module.exports.injectChatImageButtons = injectChatImageButtons;
module.exports.removeChatImageButtons = removeChatImageButtons;
});


defineModule("features/media-downloader/inject-reels.js", function (module, exports, require) {
/**
 * Reel download button — the /reels/ feed and /reel/<code>/ permalink.
 *
 * Same clone-the-send-button approach as posts: we locate the reel's action rail
 * (the ancestor of the Like button that also holds the Share button), clone the
 * Share button, and insert the clone right before it. Cloning a count-less rail
 * item (Share) means our button matches Share/Save/More exactly and never
 * disturbs the Like/Comment/Repost counts.
 */

var { extractShortcode, resolveByShortcode } = require("features/media-downloader/ig-api.js");
var { runDownload } = require("features/media-downloader/downloader.js");
var { findSendButton, injectDownloadBeforeSend, ITEM_CLASS, SEND_SELECTOR } = require("features/media-downloader/inject-common.js");

const FLAG = "data-instafn-dl-reel";

// Resolve the shortcode of the reel that owns `refEl` (the like button / rail).
//
// The reels feed stacks reels vertically and keeps neighbours mounted, so a
// naive "first /reel/ link under some ancestor" grabs the PREVIOUS reel (it's
// earlier in DOM order) — the classic off-by-one. Instead we pick the reel link
// whose vertical centre is in the viewport and closest to the rail: the active
// reel fills the screen (its link is on-screen, near the rail) while neighbours
// are scrolled off-screen. Resolved at CLICK time so it's always the reel the
// user is actually looking at, even after IG recycles DOM nodes.
function resolveReelShortcode(refEl) {
  const links = document.querySelectorAll(
    'a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]'
  );
  if (links.length) {
    const r0 = refEl.getBoundingClientRect();
    const cy0 = (r0.top + r0.bottom) / 2;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let best = null;
    let bestScore = Infinity;
    for (const l of links) {
      const code = extractShortcode(l.getAttribute("href"));
      if (!code) continue;
      const r = l.getBoundingClientRect();
      if (!r.width && !r.height) continue; // hidden / detached
      const cy = (r.top + r.bottom) / 2;
      const inView = cy >= 0 && cy <= vh;
      // On-screen links win decisively; among them, nearest to the rail wins.
      const score = (inView ? 0 : 1e7) + Math.abs(cy - cy0);
      if (score < bestScore) {
        bestScore = score;
        best = code;
      }
    }
    if (best) return best;
  }
  return extractShortcode(location.pathname);
}

// Climb from the like button to the nearest ancestor that also contains the
// share/send control — that's this reel's action rail.
function railContaining(likeWrap) {
  let node = likeWrap;
  for (let i = 0; i < 10 && node; i++) {
    if (node.querySelector?.(SEND_SELECTOR)) return node;
    node = node.parentElement;
  }
  return null;
}

function onReelSurface() {
  return (
    location.pathname.startsWith("/reels/") ||
    location.pathname.startsWith("/reel/")
  );
}

function injectForLike(likeWrap) {
  if (!likeWrap || likeWrap.getAttribute(FLAG) === "1") return;
  // Article-based layouts (feed/permalink) are owned by inject-posts; reels only
  // handles the full-screen player rail, which has no enclosing <article>.
  if (likeWrap.closest("article")) return;

  const rail = railContaining(likeWrap);
  if (!rail) return;
  if (rail.querySelector(`.${ITEM_CLASS}`)) {
    likeWrap.setAttribute(FLAG, "1");
    return;
  }

  const sendBtn = findSendButton(rail);
  if (!sendBtn) return;

  // Presence check only — the real shortcode is recomputed at click time from
  // the rail's live position so it never binds a stale/neighbouring reel.
  if (!resolveReelShortcode(likeWrap)) return;

  // Clone at rail-item level so the new item gets the rail's gap and lines up
  // with Share / Save / More (cloning the bare button stuffs it inside Share's
  // wrapper with no spacing).
  injectDownloadBeforeSend(sendBtn, rail, {
    label: "Download reel",
    surface: "reel",
    onClick: () =>
      runDownload(
        () => resolveByShortcode(resolveReelShortcode(likeWrap)),
        "reel"
      ),
  });

  likeWrap.setAttribute(FLAG, "1");
}

function injectReelButtons() {
  if (!onReelSurface()) return;
  document
    .querySelectorAll('svg[aria-label="Like"], svg[aria-label="Unlike"]')
    .forEach((svg) => {
      const wrap = svg.closest('[role="button"]');
      if (wrap) injectForLike(wrap);
    });
}

function removeReelButtons() {
  document
    .querySelectorAll(`[${FLAG}="1"]`)
    .forEach((el) => el.removeAttribute(FLAG));
  document
    .querySelectorAll(`.${ITEM_CLASS}[data-dl-surface="reel"]`)
    .forEach((el) => el.remove());
}


module.exports.injectReelButtons = injectReelButtons;
module.exports.removeReelButtons = removeReelButtons;
});


defineModule("features/media-downloader/quality.js", function (module, exports, require) {
/**
 * Quality-selection flow.
 *
 * Off by default: downloads always take the largest rendition (the descriptor's
 * `url` is already the top of the ladder — see ig-api.js), so highest quality is
 * the zero-config behaviour.
 *
 * When the "Ask for Quality" setting is on, clicking a download button first
 * opens a modal — the extension's own modal component (ui/modal.js), styled like
 * the carousel chooser — listing the available resolutions. The user's pick is
 * returned as a *target area* (px²) that's then mapped onto each media's own
 * ladder (`applyQualityTarget`), so one choice applies cleanly across a carousel
 * even when individual items expose slightly different rungs.
 */

var { createModal } = require("ui/modal.js");
var { SETTINGS_KEYS } = require("features/media-downloader/config.js");

// Sentinel meaning "always the largest rung available", independent of the
// representative item's pixel area (each item keeps its own best).
const QUALITY_HIGHEST = Infinity;

/** Read the "Ask for Quality" toggle (defaults false → no prompt). */
async function getAskQuality() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(
        { [SETTINGS_KEYS.askQuality]: false },
        (s) => resolve(!!s[SETTINGS_KEYS.askQuality])
      );
    } catch (_) {
      resolve(false);
    }
  });
}

// Collapse a ladder to distinct resolution rungs (IG sometimes repeats a size
// with different crops). Input is already sorted largest-first by ig-api.
function distinctTiers(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    const key = `${c.width}x${c.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// File extension (JPG / MP4 / WEBP …) from a candidate URL, upper-cased.
function fileType(c) {
  try {
    const p = new URL(c.url, location.href).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toUpperCase() : "";
  } catch (_) {
    return "";
  }
}

function tierLabel(c) {
  const dims =
    c.width && c.height ? `${c.width} × ${c.height}` : "Original quality";
  const type = fileType(c);
  return type ? `${dims} · ${type}` : dims;
}

/**
 * Rewrite a media descriptor's `url` to the rung nearest `targetArea`.
 * `QUALITY_HIGHEST` (or a media with ≤1 candidate) keeps the existing largest.
 */
function applyQualityTarget(media, targetArea) {
  const list = media?.candidates;
  if (!Array.isArray(list) || list.length < 2 || targetArea == null) return media;
  if (targetArea === QUALITY_HIGHEST) {
    return { ...media, url: list[0].url };
  }
  let best = list[0];
  let bestDist = Infinity;
  for (const c of list) {
    const dist = Math.abs((c.width || 0) * (c.height || 0) - targetArea);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return { ...media, url: best.url };
}

/**
 * Ask which resolution to download. `candidates` is a representative ladder
 * (e.g. the first carousel item's). Resolves to:
 *   - a target area (px²) or QUALITY_HIGHEST to download with,
 *   - null if the user cancelled.
 * If there's nothing meaningful to choose (0–1 distinct rungs), resolves
 * immediately to QUALITY_HIGHEST without showing a modal.
 */
function chooseQuality(candidates, { isVideo = false, count = 1 } = {}) {
  const tiers = distinctTiers(candidates);

  return new Promise(async (resolve) => {
    if (tiers.length < 2) {
      resolve(QUALITY_HIGHEST);
      return;
    }

    let settled = false;
    let overlay;
    const onEsc = (e) => {
      if (e.key === "Escape") done(null);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onEsc, true);
      if (overlay && overlay.parentNode) overlay.remove();
      resolve(value);
    };

    try {
      overlay = await createModal("Choose quality", { showTabs: false });
    } catch (_) {
      // Modal failed — fall back to highest quality rather than blocking.
      resolve(QUALITY_HIGHEST);
      return;
    }

    const modal = overlay.querySelector(".instafn-modal");
    modal.classList.add("instafn-modal--narrow");
    const content = overlay.querySelector(".instafn-content");

    const closeBtn = modal.querySelector(".instafn-close");
    if (closeBtn) {
      closeBtn.style.top = "16px";
      closeBtn.onclick = () => done(null);
    }

    // Slot a short description under the title (centred column header).
    const headerLeft = overlay.querySelector(".instafn-header-left");
    if (headerLeft) {
      headerLeft.style.flexDirection = "column";
      headerLeft.style.alignItems = "center";
      const desc = document.createElement("p");
      desc.className = "instafn-modal-description";
      desc.style.margin = "8px 0 0";
      desc.style.textAlign = "center";
      const kind = isVideo ? "video" : "image";
      desc.textContent =
        count > 1
          ? `Pick a resolution. It'll apply to all ${count} items.`
          : `Pick a resolution for this ${kind}.`;
      headerLeft.appendChild(desc);
    }

    const rows = tiers
      .map((c, i) => {
        const area = (c.width || 0) * (c.height || 0);
        // The top rung downloads each item's own largest (QUALITY_HIGHEST),
        // so a carousel of mixed sizes still gets every item at full quality.
        const value = i === 0 ? "max" : String(area);
        const suffix = i === 0 ? " (Highest)" : "";
        return `<button class="_a9-- _ap36 _a9_1" type="button" tabindex="0" data-area="${value}">${tierLabel(
          c
        )}${suffix}</button>`;
      })
      .join("");

    content.innerHTML = `
      <div class="_a9-v">
        <div class="_a9-z instafn-dl-rows">
          ${rows}
          <button class="_a9-- _ap36 _a9_1" type="button" tabindex="0" data-area="cancel">Cancel</button>
        </div>
      </div>`;

    content.querySelectorAll("[data-area]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const v = btn.dataset.area;
        if (v === "cancel") return done(null);
        done(v === "max" ? QUALITY_HIGHEST : Number(v));
      })
    );

    // Backdrop click → cancel (override createModal's plain remove handler so
    // our promise resolves and the button leaves its busy state).
    if (overlay._clickHandler) {
      overlay.removeEventListener("click", overlay._clickHandler);
    }
    overlay._clickHandler = (e) => {
      if (e.target === overlay) done(null);
    };
    overlay.addEventListener("click", overlay._clickHandler);
    document.addEventListener("keydown", onEsc, true);
  });
}


module.exports.QUALITY_HIGHEST = QUALITY_HIGHEST;
module.exports.getAskQuality = getAskQuality;
module.exports.applyQualityTarget = applyQualityTarget;
module.exports.chooseQuality = chooseQuality;
});


defineModule("features/media-downloader/voice-source.js", function (module, exports, require) {
/**
 * Voice-message URL source.
 *
 * A DM voice clip's .ogg URL is NOT in the rendered DOM and there's no <audio>
 * element to read. On the current Messenger/MNet DM backend it arrives only in
 * the thread's `POST /api/graphql` response, as a `SlideMessageAudiosContent`
 * node pairing `attachment_fbid` (== the waveform clip-path id) with
 * `attachment_cdn_url` (the .ogg). voice-sniffer.js captures those pairs from
 * the page as the conversation loads and relays them here; resolveVoiceUrl maps
 * the bubble's clip-path id straight to the url — instant, no playback.
 *
 * Legacy fallback: some older threads still expose voice items through the
 * private REST endpoint
 *
 *   GET /api/v1/direct_v2/threads/{canonicalId}/   -> thread.items[]
 *
 * so that path is kept as a single best-effort lookup (no aggressive pagination,
 * which used to hang for ~seconds and then fail on new-backend threads where the
 * url simply isn't present).
 */

var { igGetJson, currentThreadUrlId, resolveCanonicalId } = require("features/media-downloader/dm-thread-api.js");



// --- captured-from-page voice urls (the primary source) ----------------------

// attachment_fbid (string) -> .ogg url, filled by voice-sniffer.js via
// window.postMessage. Lives for the page's lifetime; the sniffer re-sends pairs
// whenever IG re-fetches a thread page, so this stays warm as you scroll.
const voiceUrlByFbid = new Map();
let listenerInstalled = false;

function ensureVoiceListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  // Userscript-shim note: bare `window` here is NOT guaranteed to be the
  // real page window -- Tampermonkey/Violentmonkey run userscripts in a
  // sandbox, and depending on manager/browser/injection mode, unqualified
  // `window` inside a userscript can be a distinct sandbox object from the
  // real page's window (that's exactly why the shim exposes __realWindow /
  // unsafeWindow elsewhere). voice-sniffer.js posts via the real page
  // window explicitly; listening and comparing against the ambiguous bare
  // `window` here risked silently never matching, dropping every captured
  // voice-clip pair. __realWindow is declared once in shim/02-page-inject.js
  // and is in scope here since this module runs inside that same bundle.
  var relayWindow = (typeof __realWindow !== "undefined") ? __realWindow : window;
  relayWindow.addEventListener("message", (e) => {
    if (e.source !== relayWindow) return;
    const d = e.data;
    if (!d || d.source !== "instafn-voice-dl" || !Array.isArray(d.pairs)) return;
    for (const p of d.pairs) {
      if (p && p.fbid && p.url) voiceUrlByFbid.set(String(p.fbid), p.url);
    }
  });
}

// Install as soon as this module loads (well before any download click) so we
// don't miss pairs the sniffer relays during the initial thread load.
ensureVoiceListener();

// --- voice extraction ---------------------------------------------------------

// An Instagram voice clip: .ogg served from the t59.3654-21 CDN path as
// `audioclip-*.ogg`. Kept narrow so a photo/video URL is never mistaken for one.
function isVoiceUrl(s) {
  return (
    typeof s === "string" &&
    /^https?:/.test(s) &&
    (/audioclip/i.test(s) || /t59\.3654-21/.test(s) || /\.ogg(\?|#|$)/i.test(s))
  );
}

// Walk one thread item; return { url, ids:Set<string>, durationMs } or null.
// We collect every long numeric id in the item subtree as a candidate match for
// the bubble's clip-path id (whichever field IG happens to use), shape-agnostic.
function extractVoiceFromItem(item) {
  let url = null;
  let durationMs = null;
  const ids = new Set();
  const seen = new Set();
  (function walk(v) {
    if (v == null) return;
    if (typeof v === "string") {
      if (!url && isVoiceUrl(v)) url = v;
      if (/^\d{8,25}$/.test(v)) ids.add(v);
      return;
    }
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 1e7) ids.add(String(v));
      return;
    }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    for (const k in v) {
      const val = v[k];
      if (
        durationMs == null &&
        k.toLowerCase().indexOf("duration") !== -1 &&
        typeof val === "number" &&
        val > 0 &&
        val < 3600000
      ) {
        durationMs = val;
      }
      walk(val);
    }
  })(item);
  return url ? { url, ids, durationMs } : null;
}

// --- thread fetch + per-thread cache -----------------------------------------

const THREAD_TTL_MS = 20 * 1000;
const cache = new Map(); // canonicalId -> { ts, byId:Map, byDuration:Map }

async function buildVoiceMap(canonicalId) {
  const byId = new Map(); // id string -> url
  const byDuration = new Map(); // duration secs -> url[]
  let cursor = null;
  let pages = 0;
  do {
    const q =
      "/api/v1/direct_v2/threads/" +
      canonicalId +
      "/?visual_message_return_type=unseen&limit=50" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) + "&direction=older" : "");
    let json;
    try {
      json = await igGetJson(q);
    } catch (_) {
      break;
    }
    const thread = json && json.thread;
    const items = (thread && thread.items) || [];
    for (const it of items) {
      const v = extractVoiceFromItem(it);
      if (!v) continue;
      v.ids.forEach((id) => byId.set(id, v.url));
      if (v.durationMs != null) {
        const key = Math.round(v.durationMs / 1000);
        if (!byDuration.has(key)) byDuration.set(key, []);
        byDuration.get(key).push(v.url);
      }
    }
    cursor = thread && thread.has_older ? thread.oldest_cursor || thread.prev_cursor : null;
    pages++;
    // One page only: this is a best-effort legacy fallback. The primary path is
    // the page-captured graphql map; deep pagination here just added latency.
  } while (cursor && pages < 1);

  return { ts: Date.now(), byId, byDuration };
}

async function getVoiceMap(force) {
  const urlId = currentThreadUrlId();
  if (!urlId) return null;
  const canonicalId = await resolveCanonicalId(urlId);
  if (!canonicalId) return null;
  const hit = cache.get(canonicalId);
  if (!force && hit && Date.now() - hit.ts < THREAD_TTL_MS) return hit;
  const map = await buildVoiceMap(canonicalId);
  cache.set(canonicalId, map);
  return map;
}

/**
 * Resolve a bubble's voice-clip URL from the thread payload.
 * @param {Object} q
 * @param {string|null} q.clipId      digits from the waveform clip-path id
 * @param {number|null} q.durationSec clip length parsed from the bubble's timer
 * @returns {Promise<string|null>}
 */
async function resolveVoiceUrl({ clipId, durationSec } = {}) {
  ensureVoiceListener();

  // Primary: the clip-path id (== attachment_fbid) captured from the page's
  // /api/graphql thread payload. This is where the url actually lives.
  if (clipId && voiceUrlByFbid.has(clipId)) return voiceUrlByFbid.get(clipId);

  // The graphql response may still be in flight when the button is clicked (or
  // IG may re-fetch the page on demand). Give the sniffer a brief window to
  // deliver the pair before falling back.
  if (clipId) {
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
      if (voiceUrlByFbid.has(clipId)) return voiceUrlByFbid.get(clipId);
    }
  }

  // Legacy fallback: a single best-effort REST lookup for old-backend threads.
  // One pass only — no force-refetch loop — so this never hangs.
  const map = await getVoiceMap(false);
  if (map) {
    if (clipId && map.byId.has(clipId)) return map.byId.get(clipId);
    if (durationSec != null) {
      const list = map.byDuration.get(durationSec);
      if (list && list.length === 1) return list[0];
    }
  }

  if (clipId) {
    console.debug(
      "[Instafn] voice clip not matched (graphql capture + REST);",
      "clipId:",
      clipId
    );
  }
  return null;
}


module.exports.resolveVoiceUrl = resolveVoiceUrl;
module.exports.currentThreadUrlId = currentThreadUrlId;
});


defineModule("features/media-downloader/downloader.js", function (module, exports, require) {
/**
 * Download dispatch.
 *
 * Two paths:
 *  - http(s) CDN urls  → handed to the background worker's chrome.downloads
 *    bridge. That avoids CORS entirely (the browser fetches it, not the page),
 *    forces a real "Save", and lets us set a clean filename. fbcdn/cdninstagram
 *    are cross-origin and would otherwise be undownloadable from the page.
 *  - blob:/data: urls  → can't cross the content↔background boundary (the blob
 *    lives in the page), so those are saved with a same-document <a download>.
 */

var { DOWNLOAD_MSG, SETTINGS_KEYS } = require("features/media-downloader/config.js");
var { showToast, CHECK_ICON } = require("ui/toast.js");
var { getAskQuality, chooseQuality, applyQualityTarget } = require("features/media-downloader/quality.js");
var { embedMetadataInJpeg, embedMetadataInOgg, isEmptyMetadata } = require("features/media-downloader/metadata.js");

function extFromUrl(url, type) {
  try {
    const path = new URL(url, location.href).pathname;
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch (_) {}
  return type === "video" ? "mp4" : "jpg";
}

function sanitize(part) {
  return String(part || "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/**
 * Build the filename base (no extension):
 *   <username>_<code>[_NofM]   — e.g. affan_Cxyz123, affan_Cxyz123_2of5
 *   <username>_profile         — profile pictures
 * Falls back to "instagram" if neither username nor code is known.
 */
function fileBase(media) {
  const bits = [];
  if (media.username) bits.push(sanitize(media.username));
  if (media.code === "profile") bits.push("profile");
  else if (media.code) bits.push(sanitize(media.code));
  if (media.total > 1) bits.push(`${media.index}of${media.total}`);
  return bits.join("_") || "instagram";
}

/** Build a stable, human-friendly filename: <username>_<code>[_NofM].<ext>. */
function buildFilename(media) {
  const ext = extFromUrl(media.url, media.type);
  return `${fileBase(media)}.${ext}`;
}

function isInlineUrl(url) {
  return /^(blob:|data:)/i.test(url);
}

function anchorDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

async function getAskLocation() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(
        { [SETTINGS_KEYS.askLocation]: false },
        (s) => resolve(!!s[SETTINGS_KEYS.askLocation])
      );
    } catch (_) {
      resolve(false);
    }
  });
}

/** Read the "Embed metadata" toggle (defaults true). */
async function getEmbedMetadata() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(
        { [SETTINGS_KEYS.embedMetadata]: true },
        (s) => resolve(!!s[SETTINGS_KEYS.embedMetadata])
      );
    } catch (_) {
      resolve(false);
    }
  });
}

// Save raw bytes as a same-document blob download. Used for metadata-embedded
// images and video sidecar text — neither can cross to the background bridge
// (the blob lives in this page). Note: a blob <a download> can't honour the
// "Ask Where to Save" dialog, so embedded images always go to the default
// Downloads folder regardless of that toggle.
function saveBytes(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  anchorDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// Cross-origin fetch of CDN bytes. cdninstagram/fbcdn are in host_permissions,
// so the content script reads them without tripping CORS (same path as zip.js).
async function fetchBytes(url) {
  const resp = await fetch(url, { credentials: "omit" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}


// Fire one message at the background bridge. Resolves {ok, error} — never
// rejects — so the caller can decide whether to retry.
function sendToBridge(url, filename, saveAs) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: DOWNLOAD_MSG, url, filename, saveAs },
        (resp) => {
          const err = chrome.runtime.lastError?.message;
          if (err) resolve({ ok: false, error: err });
          else if (!resp?.ok) resolve({ ok: false, error: resp?.error || "download failed" });
          else resolve({ ok: true });
        }
      );
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

// Transient failures clear on a retry: an asleep MV3 service worker can drop the
// first wake-up message ("message port closed", "could not establish
// connection"), and chrome.downloads can momentarily report a network/connection
// blip. A second attempt wakes the worker and usually succeeds.
function isTransient(error) {
  return /message port closed|establish connection|network|connection|no response|worker/i.test(
    error || ""
  );
}

// The extension was reloaded/updated while this tab stayed open, orphaning the
// content script. Nothing will work until the page is refreshed.
function isContextGone(error) {
  return /context invalidated|receiving end does not exist/i.test(error || "");
}

/** Download a single resolved media descriptor. Returns a Promise<boolean>. */
async function downloadMedia(media) {
  if (!media?.url) return false;
  const filename = buildFilename(media);

  if (isInlineUrl(media.url)) {
    anchorDownload(media.url, filename);
    return true;
  }

  const embed =
    media.metadata &&
    !isEmptyMetadata(media.metadata) &&
    (await getEmbedMetadata());

  // Photos: fetch the bytes, bake the metadata in as an XMP packet and save the
  // rewritten JPEG. Non-JPEG (e.g. webp) can't be embedded → fall through to the
  // normal bridge path. Any fetch/embed failure also falls through, so the media
  // is never lost just because metadata couldn't be attached.
  if (embed && media.type === "image") {
    try {
      const bytes = await fetchBytes(media.url);
      const injected = embedMetadataInJpeg(bytes, media.metadata);
      if (injected) {
        saveBytes(injected, filename, "image/jpeg");
        return true;
      }
    } catch (e) {
      console.warn("[instafn] metadata embed failed, saving without:", e);
    }
  }

  // Voice notes (.ogg): bake the metadata in as native Opus/Vorbis comment tags
  // and save the rewritten file. Same fall-through guarantee — if the fetch or
  // the embed can't be done cleanly, the clip still downloads via the bridge.
  if (embed && media.type === "audio") {
    try {
      const bytes = await fetchBytes(media.url);
      const tagged = embedMetadataInOgg(bytes, media.metadata);
      if (tagged) {
        saveBytes(tagged, filename, "audio/ogg");
        return true;
      }
    } catch (e) {
      console.warn("[instafn] voice metadata embed failed, saving without:", e);
    }
  }

  const saveAs = await getAskLocation();

  let result = await sendToBridge(media.url, filename, saveAs);
  if (!result.ok && isTransient(result.error)) {
    await new Promise((r) => setTimeout(r, 350)); // give the worker time to wake
    result = await sendToBridge(media.url, filename, saveAs);
  }
  if (result.ok) return true;

  // Still failing. Surface the real reason instead of silently opening a tab.
  console.warn("[instafn] download bridge failed:", result.error, media.url);
  if (isContextGone(result.error)) {
    showToast("Refresh Instagram to re-enable downloads.", { duration: 3000 });
    return false;
  }
  // Last resort so the media is never wholly lost — but the user is told why.
  showToast("Couldn't save directly; opened it in a new tab.", { duration: 3000 });
  window.open(media.url, "_blank", "noopener");
  return false;
}

/**
 * Optional quality prompt for a resolved media list. Off by default → returns
 * the list untouched (highest-quality urls). When "Ask for Quality" is on and a
 * representative item has more than one rung, asks once and maps that choice
 * across every item. Returns null if the user cancelled. Shared by every surface
 * so the prompt behaves identically for posts, reels, stories, attachments, etc.
 */
async function maybePromptQuality(list) {
  if (!(await getAskQuality())) return list;
  const repr = list.find((m) => m.candidates && m.candidates.length > 1);
  if (!repr) return list;
  const target = await chooseQuality(repr.candidates, {
    isVideo: repr.type === "video",
    count: list.length,
  });
  if (target === null) return null; // cancelled
  return list.map((m) => applyQualityTarget(m, target));
}

/**
 * Resolve (via the supplied async resolver) then download everything it returns,
 * with toast feedback. `resolver` is a function returning Promise<media[]>.
 */
async function runDownload(resolver, label = "media") {
  let list;
  try {
    list = await resolver();
  } catch (err) {
    showToast(`Download failed: ${err.message || err}`, { duration: 2600 });
    return;
  }
  if (!list || !list.length) {
    showToast("Couldn't find anything to download here.", { duration: 2600 });
    return;
  }

  const picked = await maybePromptQuality(list);
  if (picked === null) return; // cancelled
  list = picked;

  if (list.length > 1) {
    showToast(`Downloading ${list.length} items…`, { duration: 2000 });
  }

  let ok = 0;
  for (const media of list) {
    // Small stagger so the browser's download manager doesn't drop concurrent
    // requests for big carousels.
    // eslint-disable-next-line no-await-in-loop
    const done = await downloadMedia(media);
    if (done) ok++;
    if (list.length > 1) await new Promise((r) => setTimeout(r, 350));
  }

  if (ok > 0 && list.length === 1) {
    showToast("Saved", { duration: 1400, icon: CHECK_ICON });
  } else if (ok > 0) {
    showToast(`Saved ${ok}/${list.length}`, { duration: 1800, icon: CHECK_ICON });
  }
}


module.exports.fileBase = fileBase;
module.exports.buildFilename = buildFilename;
module.exports.getEmbedMetadata = getEmbedMetadata;
module.exports.downloadMedia = downloadMedia;
module.exports.maybePromptQuality = maybePromptQuality;
module.exports.runDownload = runDownload;
});


defineModule("features/media-downloader/inject-audio.js", function (module, exports, require) {
/**
 * DM voice-message download.
 *
 * Voice clips render as a waveform (svg[aria-label="Waveform for audio message"])
 * + play control inside the message bubble. The .ogg URL is in neither the DOM
 * nor an <audio> element — so rather than read React internals or make the user
 * play the clip, we pull the link from the same private DM API Instagram already
 * used to load the conversation (see voice-source.js) and map it to this bubble
 * via the waveform's clip-path id.
 *
 * We just drop a small download button into the bubble's corner; on click we
 * resolve the URL and hand it to the chrome.downloads bridge.
 */

var { createDownloadButton } = require("features/media-downloader/ui.js");
var { BUTTON_CLASS } = require("features/media-downloader/config.js");
var { downloadMedia, maybePromptQuality } = require("features/media-downloader/downloader.js");
var { showToast, CHECK_ICON } = require("ui/toast.js");
var { resolveVoiceUrl } = require("features/media-downloader/voice-source.js");
var { MESSAGE_GROUP_SELECTOR } = require("features/_shared/dm-message-actions.js");

const FLAG = "data-instafn-dl-audio";
const WAVEFORM_SEL = 'svg[aria-label="Waveform for audio message"]';

// The peach voice bubble for a waveform svg — where we anchor the button.
function bubbleFor(waveform) {
  return (
    waveform.closest('[role="presentation"]') ||
    waveform.closest('[role="group"][tabindex="-1"]') ||
    waveform.parentElement
  );
}

// Instagram derives the waveform clip-path id from the message/media id, so it's
// our key back into the thread payload. e.g. "waveform-clip-path-1727482385064910".
function clipIdFor(scope) {
  const cp = scope.querySelector('clipPath[id^="waveform-clip-path-"]');
  const m = cp?.id.match(/(\d{6,})/);
  return m ? m[1] : null;
}

// Clip length from the bubble's timer ("0:04") in whole seconds, for the
// duration fallback match.
function durationSecFor(scope) {
  const txt = scope.querySelector('[role="timer"]')?.textContent?.trim() || "";
  const m = txt.match(/(\d+):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Instagram media ids begin with a Unix-seconds creation timestamp, so the
// waveform's attachment_fbid (== clipId) gives us the message's send time
// without any extra lookup. Returns a Date or null.
function sentDateFromClipId(clipId) {
  if (!clipId || clipId.length < 10) return null;
  const sec = parseInt(clipId.slice(0, 10), 10);
  // sanity: 2012..2100
  if (!(sec > 1325376000 && sec < 4102444800)) return null;
  return new Date(sec * 1000);
}

// Outgoing bubbles tint their controls with --ig-outgoing-message-bubble; label
// those "You". The chat partner's handle isn't reliably in the DOM, so incoming
// notes are left without an artist tag rather than guessing wrong.
function senderFor(scope) {
  return scope.querySelector('[style*="outgoing-message-bubble"]') ? "You" : "";
}

// Build the descriptor (descriptive filename bits + embeddable metadata) for a
// voice note. Filename → e.g. instagram_voice_2024-09-27_1453.ogg
function voiceDescriptor(clipId, group, url) {
  const date = sentDateFromClipId(clipId);
  const iso = date ? date.toISOString() : "";
  let code = "voice";
  if (date) {
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(
      date.getDate()
    )}_${p(date.getHours())}${p(date.getMinutes())}`;
    code = `voice_${stamp}`;
  }
  const sender = senderFor(group);
  const link = location.href.split(/[?#]/)[0];
  return {
    type: "audio",
    url,
    username: "instagram",
    code,
    index: 1,
    total: 1,
    metadata: {
      title: "Instagram voice message",
      artist: sender,
      date: iso,
      description: `Instagram Direct voice message${
        iso ? " sent " + iso.slice(0, 10) : ""
      }`,
      link,
    },
  };
}

function injectForGroup(group) {
  if (!group) return;
  const waveform = group.querySelector(WAVEFORM_SEL);
  if (!waveform) return;

  const bubble = bubbleFor(waveform);
  if (!bubble || bubble.getAttribute(FLAG) === "1") return;
  if (bubble.querySelector(`.${BUTTON_CLASS}`)) {
    bubble.setAttribute(FLAG, "1");
    return;
  }

  const btn = createDownloadButton({
    title: "Download voice message",
    variant: "instafn-dl-audio",
    size: 15,
    onClick: async () => {
      const url = await resolveVoiceUrl({
        clipId: clipIdFor(group),
        durationSec: durationSecFor(group),
      });
      if (!url) {
        showToast("Couldn't find this clip's link. Reopen the chat and retry.", {
          duration: 2800,
        });
        return;
      }
      // A voice note has a single rendition, so the quality prompt only ever
      // no-ops here — routed through it anyway so behaviour stays uniform.
      const picked = await maybePromptQuality([
        voiceDescriptor(clipIdFor(group), group, url),
      ]);
      if (picked === null) return; // cancelled
      const ok = await downloadMedia(picked[0]);
      if (ok) showToast("Saved", { duration: 1800, icon: CHECK_ICON });
      else showToast("Couldn't save this clip.", { duration: 1800 });
    },
  });

  const wrapper = document.createElement("span");
  wrapper.className = "instafn-dl-audio-wrap";
  wrapper.appendChild(btn);

  // Overlay the button in the bubble's corner. Ensure the bubble is a positioned
  // ancestor so the absolutely-placed wrapper lands inside it (instead of being
  // flung to the bottom of the full-width message row, as a plain append did).
  if (getComputedStyle(bubble).position === "static") {
    bubble.style.position = "relative";
  }
  bubble.appendChild(wrapper);
  bubble.setAttribute(FLAG, "1");
}

function injectAudioButtons() {
  // Only meaningful in the DM surface.
  if (!location.pathname.startsWith("/direct/")) return;
  document.querySelectorAll(MESSAGE_GROUP_SELECTOR).forEach(injectForGroup);
}

function removeAudioButtons() {
  document
    .querySelectorAll(`[${FLAG}="1"]`)
    .forEach((el) => el.removeAttribute(FLAG));
  document
    .querySelectorAll(".instafn-dl-audio-wrap")
    .forEach((el) => el.remove());
}


module.exports.injectAudioButtons = injectAudioButtons;
module.exports.removeAudioButtons = removeAudioButtons;
});


defineModule("features/media-downloader/carousel.js", function (module, exports, require) {
/**
 * Carousel download flow.
 *
 * Single-media posts download straight away. Carousels first ask — via the
 * extension's own modal component (ui/modal.js) — whether to grab the current
 * slide, every item as separate files, or every item bundled into one .zip.
 */

var { createModal } = require("ui/modal.js");
var { showToast, CHECK_ICON } = require("ui/toast.js");
var { downloadMedia, maybePromptQuality } = require("features/media-downloader/downloader.js");
var { buildZipDownload } = require("features/media-downloader/zip.js");

// ---------------------------------------------------------------------------
// The choice dialog — our own modal component (ui/modal.js) for the shell
// (card shape, radius, colours, zoom animation, header + close), with the
// IG-native action-sheet rows slotted into its content.
// ---------------------------------------------------------------------------

/** Ask how to download a carousel. Resolves to 'current' | 'separate' | 'zip' | null. */
function chooseCarouselDownload(count) {
  return new Promise(async (resolve) => {
    let settled = false;
    let overlay;
    const onEsc = (e) => {
      if (e.key === "Escape") done(null);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onEsc, true);
      if (overlay && overlay.parentNode) overlay.remove();
      resolve(value);
    };

    try {
      overlay = await createModal("Download carousel", { showTabs: false });
    } catch (_) {
      resolve("separate"); // modal failed — fall back to the safe default
      return;
    }

    const modal = overlay.querySelector(".instafn-modal");
    modal.classList.add("instafn-modal--narrow");
    const content = overlay.querySelector(".instafn-content");

    // Slot the description into the modal header, under the title (stack the
    // header's title block into a column so they sit centred together).
    // Pin the close button to the top so it aligns with the title instead of
    // floating to the vertical centre of the now-taller header (where it would
    // overlap the description). Also wire it to cancel.
    const closeBtn = modal.querySelector(".instafn-close");
    if (closeBtn) {
      closeBtn.style.top = "16px";
      closeBtn.onclick = () => done(null);
    }

    const headerLeft = overlay.querySelector(".instafn-header-left");
    if (headerLeft) {
      headerLeft.style.flexDirection = "column";
      headerLeft.style.alignItems = "center";
      const desc = document.createElement("p");
      desc.className = "instafn-modal-description";
      desc.style.margin = "8px 0 0";
      desc.style.textAlign = "center";
      desc.textContent = `This post has ${count} items. Choose how you'd like to download them.`;
      headerLeft.appendChild(desc);
    }

    content.innerHTML = `
      <div class="_a9-v">
        <div class="_a9-z instafn-dl-rows">
          <button class="_a9-- _ap36 _a9_1" type="button" tabindex="0" data-choice="current">Current item only</button>
          <button class="_a9-- _ap36 _a9_1" type="button" tabindex="0" data-choice="separate">All ${count} as separate files</button>
          <button class="_a9-- _ap36 _a9_1" type="button" tabindex="0" data-choice="zip">All ${count} as a .zip</button>
          <button class="_a9-- _ap36 _a9_1" type="button" tabindex="0" data-choice="cancel">Cancel</button>
        </div>
      </div>`;

    content.querySelectorAll("[data-choice]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const c = btn.dataset.choice;
        done(c === "cancel" ? null : c);
      })
    );

    // Backdrop click → cancel (override createModal's plain remove handler so
    // our promise resolves and the button leaves its busy state).
    if (overlay._clickHandler) {
      overlay.removeEventListener("click", overlay._clickHandler);
    }
    overlay._clickHandler = (e) => {
      if (e.target === overlay) done(null);
    };
    overlay.addEventListener("click", overlay._clickHandler);
    document.addEventListener("keydown", onEsc, true);
  });
}

// ---------------------------------------------------------------------------
// Which slide is showing?
// ---------------------------------------------------------------------------

// A CDN media filename starts with a long numeric id unique to that carousel
// child; both the rendered (downscaled) image and the API's high-res candidate
// share it, so we can map the on-screen slide to a list entry by this token.
// Position-independent — survives IG windowing the dot strip on long carousels.
function mediaToken(url) {
  try {
    const file = new URL(url, location.href).pathname.split("/").pop() || "";
    const m = file.match(/\d{10,}/);
    return m ? m[0] : "";
  } catch (_) {
    return "";
  }
}

function matchByVisibleMedia(root, list) {
  const rootRect = root.getBoundingClientRect();
  const cx = rootRect.left + rootRect.width / 2;

  const medias = Array.from(root.querySelectorAll("img, video")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 100;
  });

  // The slide on screen is the large media whose horizontal centre is nearest
  // the carousel's centre.
  let chosen = null;
  let best = Infinity;
  for (const el of medias) {
    const r = el.getBoundingClientRect();
    if (r.right < rootRect.left || r.left > rootRect.right) continue;
    const d = Math.abs(r.left + r.width / 2 - cx);
    if (d < best) {
      best = d;
      chosen = el;
    }
  }
  if (!chosen) return -1;

  const token = mediaToken(
    chosen.currentSrc || chosen.src || chosen.poster || ""
  );
  if (!token) return -1;

  return list.findIndex((m) => {
    const t = mediaToken(m.url);
    return t && (t === token || t.includes(token) || token.includes(t));
  });
}

// Fallback: the active carousel dot. IG marks the current dot with an extra
// class, so it's the odd-one-out among the dot classNames. Correct whenever the
// dot strip isn't windowed (i.e. most carousels).
function matchByActiveDot(root) {
  const strip = root.querySelector("._acnc");
  if (!strip) return -1;
  const dots = Array.from(strip.querySelectorAll(":scope > ._acnb"));
  if (dots.length < 2) return -1;
  const counts = {};
  dots.forEach((d) => (counts[d.className] = (counts[d.className] || 0) + 1));
  return dots.findIndex((d) => counts[d.className] === 1);
}

function currentCarouselIndex(root, list) {
  if (!root) return 0;
  const byMedia = matchByVisibleMedia(root, list);
  if (byMedia >= 0) return byMedia;
  const byDot = matchByActiveDot(root);
  if (byDot >= 0 && byDot < list.length) return byDot;
  return 0;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Resolve a post's media (via `resolver`) and download it. Single media saves
 * immediately; carousels prompt for current / all-separate / zip. `root` is the
 * post's <article>, used to detect the on-screen slide for "current".
 */
async function handlePostDownload(resolver, root) {
  let list;
  try {
    list = await resolver();
  } catch (err) {
    showToast(`Download failed: ${err.message || err}`, { duration: 2600 });
    return;
  }
  if (!list || !list.length) {
    showToast("Couldn't find anything to download here.", { duration: 2600 });
    return;
  }

  // Single media: optional quality prompt, then save.
  if (list.length === 1) {
    const picked = await maybePromptQuality(list);
    if (picked === null) return; // cancelled
    const ok = await downloadMedia(picked[0]);
    if (ok) showToast("Saved", { duration: 1500, icon: CHECK_ICON });
    else showToast("Couldn't save this.", { duration: 1500 });
    return;
  }

  // Carousel: ask the scope question FIRST (current / all-separate / zip), then
  // the quality prompt — scoped to exactly what's being saved. For "current"
  // that's the single on-screen item (so its own ladder drives the rungs); for
  // separate/zip the one choice maps across every item.
  const choice = await chooseCarouselDownload(list.length);
  if (!choice) return;

  if (choice === "current") {
    const idx = currentCarouselIndex(root, list);
    const picked = await maybePromptQuality([list[idx]]);
    if (picked === null) return; // cancelled
    const ok = await downloadMedia(picked[0]);
    if (ok) showToast(`Saved item ${idx + 1}`, { duration: 1600, icon: CHECK_ICON });
    else showToast("Couldn't save this.", { duration: 1600 });
    return;
  }

  const picked = await maybePromptQuality(list);
  if (picked === null) return; // cancelled
  const items = picked;

  if (choice === "zip") {
    await buildZipDownload(items);
    return;
  }

  // 'separate'
  showToast(`Downloading ${items.length} items…`, { duration: 1800 });
  let ok = 0;
  for (const m of items) {
    // eslint-disable-next-line no-await-in-loop
    if (await downloadMedia(m)) ok++;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 350));
  }
  showToast(`Saved ${ok}/${items.length}`, { duration: 2000, icon: CHECK_ICON });
}


module.exports.handlePostDownload = handlePostDownload;
});


defineModule("features/media-downloader/metadata.js", function (module, exports, require) {
/**
 * Post metadata extraction + embedding.
 *
 * Everything here is derived from the SAME `/api/v1/media/<id>/info/` response
 * the downloader already fetches to resolve the highest-quality renditions — no
 * extra network requests. `resolveMediaById` / `resolveByShortcode` keep the raw
 * API item around long enough for `extractMetadata` to pluck the descriptive
 * fields, which then travel with each download descriptor as `media.metadata`.
 *
 * Photos get the metadata baked straight into the file — a binary EXIF/TIFF APP1
 * (date, GPS, caption, creator — what Finder/Explorer/Photos read) plus an XMP
 * packet (keywords, alt text, post link, location name). No sidecar files. The
 * embedded source URL is always the POST permalink, never the image CDN URL.
 * Videos aren't rewritten in-browser (would need MP4 container surgery), so they
 * download without embedded metadata for now.
 */

// ---------------------------------------------------------------------------
// Extraction — raw API item → normalized metadata
// ---------------------------------------------------------------------------

// Pull #hashtags out of a caption, deduped, in first-seen order, '#'-stripped.
function hashtagsFromCaption(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const re = /#([\p{L}\p{N}_]+)/gu;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[1];
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

function locationFrom(item) {
  const loc = item?.location;
  if (!loc) return null;
  const name = loc.name || loc.short_name || "";
  const lat = typeof loc.lat === "number" ? loc.lat : null;
  const lng = typeof loc.lng === "number" ? loc.lng : null;
  if (!name && lat == null && lng == null) return null;
  return {
    name,
    city: loc.city || "",
    address: loc.address || "",
    lat,
    lng,
  };
}

/**
 * Build a normalized metadata object from the top-level API `item` (caption,
 * user, location, date all live there) and, for carousels, the per-slide
 * `child` (which carries its own alt text). `code`/index info comes from the
 * descriptor meta the caller already computed.
 */
function extractMetadata(item, child, extra = {}) {
  if (!item) return null;
  const node = child || item;
  const captionText = item.caption?.text || "";
  const code = item.code || extra.code || "";
  const username = item.user?.username || extra.username || "";
  const takenAtSec = node.taken_at || item.taken_at || item.caption?.created_at;
  const takenAt = takenAtSec ? new Date(takenAtSec * 1000).toISOString() : "";

  return {
    altText: node.accessibility_caption || item.accessibility_caption || "",
    caption: captionText,
    creator: item.user?.full_name || "",
    username,
    location: locationFrom(item),
    takenAt,
    code,
    link: code ? `https://www.instagram.com/p/${code}/` : "",
    keywords: hashtagsFromCaption(captionText),
  };
}

/** Metadata for a profile picture (no post — link points at the profile). */
function profileMetadata(username, fullName) {
  if (!username) return null;
  return {
    altText: "",
    caption: "",
    creator: fullName || "",
    username,
    location: null,
    takenAt: "",
    code: "profile",
    link: `https://www.instagram.com/${username}/`,
    keywords: [],
  };
}

function isEmptyMetadata(meta) {
  if (!meta) return true;
  return (
    !meta.altText &&
    !meta.caption &&
    !meta.creator &&
    !meta.link &&
    !meta.takenAt &&
    !meta.location &&
    (!meta.keywords || !meta.keywords.length)
  );
}

// ---------------------------------------------------------------------------
// XMP packet
// ---------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// XMP/EXIF GPS coordinate: "deg,min.decN" (degrees integer, minutes decimal,
// hemisphere ref). This is the exif:GPSLatitude/Longitude string form most
// readers (incl. exiftool) accept.
function toXmpGps(value, posRef, negRef) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg},${min.toFixed(6)}${value >= 0 ? posRef : negRef}`;
}

/**
 * Render the metadata as an XMP packet (XML). Maps onto standard Dublin Core /
 * IPTC / Photoshop / EXIF schemas so generic tools surface the fields, and also
 * mirrors everything under a private `instafn:` namespace for a clean round-trip.
 */
function buildXmpPacket(meta) {
  const props = [];

  // dc:description ← the post caption (what photo viewers show as "Description").
  if (meta.caption) {
    props.push(
      `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(
        meta.caption
      )}</rdf:li></rdf:Alt></dc:description>`
    );
  }
  // The accessibility alt text → exif:UserComment + IPTC alt-text accessibility.
  if (meta.altText) {
    props.push(
      `<exif:UserComment><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(
        meta.altText
      )}</rdf:li></rdf:Alt></exif:UserComment>`
    );
    props.push(
      `<Iptc4xmpCore:AltTextAccessibility><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(
        meta.altText
      )}</rdf:li></rdf:Alt></Iptc4xmpCore:AltTextAccessibility>`
    );
  }
  if (meta.creator) {
    props.push(
      `<dc:creator><rdf:Seq><rdf:li>${xmlEscape(
        meta.creator
      )}</rdf:li></rdf:Seq></dc:creator>`
    );
  }
  if (meta.keywords && meta.keywords.length) {
    const items = meta.keywords
      .map((k) => `<rdf:li>${xmlEscape(k)}</rdf:li>`)
      .join("");
    props.push(`<dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject>`);
  }
  if (meta.takenAt) {
    const localDate = localIsoString(meta.takenAt);
    props.push(`<xmp:CreateDate>${xmlEscape(localDate)}</xmp:CreateDate>`);
    props.push(
      `<photoshop:DateCreated>${xmlEscape(localDate)}</photoshop:DateCreated>`
    );
  }
  if (meta.link) {
    props.push(`<dc:source>${xmlEscape(meta.link)}</dc:source>`);
    props.push(`<photoshop:Source>${xmlEscape(meta.link)}</photoshop:Source>`);
  }
  if (meta.location) {
    if (meta.location.name) {
      props.push(
        `<Iptc4xmpCore:Location>${xmlEscape(
          meta.location.name
        )}</Iptc4xmpCore:Location>`
      );
    }
    if (meta.location.city) {
      props.push(
        `<photoshop:City>${xmlEscape(meta.location.city)}</photoshop:City>`
      );
    }
    const lat = toXmpGps(meta.location.lat, "N", "S");
    const lng = toXmpGps(meta.location.lng, "E", "W");
    if (lat) props.push(`<exif:GPSLatitude>${lat}</exif:GPSLatitude>`);
    if (lng) props.push(`<exif:GPSLongitude>${lng}</exif:GPSLongitude>`);
  }

  // Private namespace — verbatim fields, so re-importing is lossless.
  const ifn = [];
  if (meta.username) ifn.push(`instafn:username="${xmlEscape(meta.username)}"`);
  if (meta.code) ifn.push(`instafn:shortcode="${xmlEscape(meta.code)}"`);
  if (meta.link) ifn.push(`instafn:link="${xmlEscape(meta.link)}"`);
  if (meta.altText) ifn.push(`instafn:altText="${xmlEscape(meta.altText)}"`);

  const desc =
    `<rdf:Description rdf:about=""` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
    ` xmlns:xmp="http://ns.adobe.com/xap/1.0/"` +
    ` xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"` +
    ` xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"` +
    ` xmlns:exif="http://ns.adobe.com/exif/1.0/"` +
    ` xmlns:instafn="https://instafn.local/ns/1.0/"` +
    (ifn.length ? " " + ifn.join(" ") : "") +
    `>${props.join("")}</rdf:Description>`;

  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    desc +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

// ---------------------------------------------------------------------------
// Binary EXIF (APP1)
//
// XMP stores dates/coords as ISO/text strings — that's the XMP spec, but most
// OS file browsers and photo apps read the *binary* EXIF tags for "Date taken"
// and the map pin. So we also emit a real little-endian EXIF/TIFF block:
//   IFD0:   ImageDescription (caption), DateTime, Artist (creator),
//           + ExifIFD pointer, + GPS IFD pointer
//   ExifIFD: DateTimeOriginal, DateTimeDigitized   ("YYYY:MM:DD HH:MM:SS")
//   GPS IFD: lat/lng as RATIONAL[3] (deg, min, sec) with N/S, E/W refs
// ---------------------------------------------------------------------------

const T_BYTE = 1;
const T_ASCII = 2;
const T_LONG = 4;
const T_RATIONAL = 5;

function u8concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function le32(n) {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setUint32(0, n >>> 0, true);
  return o;
}

// Null-terminated ASCII (EXIF ASCII type); non-ASCII chars degrade to '?'.
function asciiBytes(str) {
  const s = String(str == null ? "" : str);
  const arr = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    arr.push(c < 0x80 ? c : 0x3f);
  }
  arr.push(0);
  return new Uint8Array(arr);
}

// `taken_at` is a UTC epoch. EXIF DateTimeOriginal is conventionally *local*
// wall-clock with no tz field — we don't know the creator's zone, so we render
// it in the viewer's local timezone (matching how Instagram itself displays the
// post time) and record the offset separately via exifOffsetString() /
// OffsetTime* tags, so the absolute instant is never ambiguous. No timezone is
// hardcoded — it comes from the runtime environment.
function exifDateString(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Viewer-local UTC offset for `iso`, EXIF/ISO form ("+01:00" / "-05:00").
// getTimezoneOffset() is minutes *behind* UTC (negative when ahead), and it
// honours DST for that specific date.
function exifOffsetString(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const p = (n) => String(n).padStart(2, "0");
  return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

// Full local ISO 8601 with offset (e.g. "2024-03-12T11:40:00+01:00") — the
// correct XMP/human representation of the same instant. Falls back to the raw
// UTC string if parsing fails.
function localIsoString(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "";
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    exifOffsetString(iso)
  );
}

// One GPS coordinate as 3 LE RATIONALs: deg/1, min/1, sec*10000/10000 (24 bytes).
function gpsCoordBytes(value) {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minF = (abs - deg) * 60;
  const min = Math.floor(minF);
  const secNum = Math.round((minF - min) * 60 * 10000);
  const out = new Uint8Array(24);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, deg, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, min, true);
  dv.setUint32(12, 1, true);
  dv.setUint32(16, secNum, true);
  dv.setUint32(20, 10000, true);
  return out;
}

const entry = (tag, type, count, value) => ({ tag, type, count, value });

// Total bytes an entry list spills into its IFD's data area (values > 4 bytes,
// word-aligned to even length). Inline values (≤4 bytes) live in the table.
function ifdExtraLen(entries) {
  return entries.reduce((s, e) => {
    const L = e.value.length;
    return s + (L > 4 ? L + (L % 2) : 0);
  }, 0);
}

// Serialize one IFD (table + its data area) at absolute `ifdOffset` in the TIFF.
function serializeIfd(entries, ifdOffset, nextIfdOffset = 0) {
  const sorted = entries.slice().sort((a, b) => a.tag - b.tag); // ascending tags
  const n = sorted.length;
  const tableSize = 2 + 12 * n + 4;
  const table = new Uint8Array(tableSize);
  const dv = new DataView(table.buffer);
  dv.setUint16(0, n, true);
  let dataCursor = ifdOffset + tableSize;
  const dataChunks = [];
  let p = 2;
  for (const e of sorted) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    const v = e.value;
    if (v.length <= 4) {
      for (let i = 0; i < v.length; i++) table[p + 8 + i] = v[i];
    } else {
      dv.setUint32(p + 8, dataCursor, true);
      dataChunks.push(v);
      dataCursor += v.length;
      if (v.length % 2 === 1) {
        dataChunks.push(new Uint8Array([0])); // word-align
        dataCursor++;
      }
    }
    p += 12;
  }
  dv.setUint32(2 + 12 * n, nextIfdOffset, true);
  return u8concat([table, u8concat(dataChunks)]);
}

/** Build a complete EXIF APP1 segment for `meta`, or null if there's nothing. */
function buildExifApp1(meta) {
  if (!meta) return null;
  const date = exifDateString(meta.takenAt);
  const hasGps =
    meta.location &&
    typeof meta.location.lat === "number" &&
    typeof meta.location.lng === "number";
  if (!date && !hasGps && !meta.caption && !meta.creator) return null;

  const exifEntries = [];
  if (date) {
    const db = asciiBytes(date);
    exifEntries.push(entry(0x9003, T_ASCII, db.length, db)); // DateTimeOriginal
    exifEntries.push(entry(0x9004, T_ASCII, db.length, db)); // DateTimeDigitized
    const offset = exifOffsetString(meta.takenAt); // e.g. "+01:00"
    if (offset) {
      const ob = asciiBytes(offset);
      exifEntries.push(entry(0x9010, T_ASCII, ob.length, ob)); // OffsetTime
      exifEntries.push(entry(0x9011, T_ASCII, ob.length, ob)); // OffsetTimeOriginal
      exifEntries.push(entry(0x9012, T_ASCII, ob.length, ob)); // OffsetTimeDigitized
    }
  }

  const gpsEntries = [];
  if (hasGps) {
    gpsEntries.push(entry(0x0000, T_BYTE, 4, new Uint8Array([2, 3, 0, 0])));
    gpsEntries.push(
      entry(0x0001, T_ASCII, 2, asciiBytes(meta.location.lat >= 0 ? "N" : "S"))
    );
    gpsEntries.push(entry(0x0002, T_RATIONAL, 3, gpsCoordBytes(meta.location.lat)));
    gpsEntries.push(
      entry(0x0003, T_ASCII, 2, asciiBytes(meta.location.lng >= 0 ? "E" : "W"))
    );
    gpsEntries.push(entry(0x0004, T_RATIONAL, 3, gpsCoordBytes(meta.location.lng)));
  }

  const ifd0Entries = [];
  if (meta.caption) {
    const b = asciiBytes(meta.caption);
    ifd0Entries.push(entry(0x010e, T_ASCII, b.length, b)); // ImageDescription
  }
  if (date) {
    const b = asciiBytes(date);
    ifd0Entries.push(entry(0x0132, T_ASCII, b.length, b)); // DateTime
  }
  if (meta.creator) {
    const b = asciiBytes(meta.creator);
    ifd0Entries.push(entry(0x013b, T_ASCII, b.length, b)); // Artist
  }

  // Lay out IFDs sequentially (TIFF header is 8 bytes, IFD0 starts at offset 8).
  // Pointer-entry VALUES are inline 4-byte offsets, so IFD0's size is known from
  // its entry count + extra data alone — independent of those offsets.
  const hasExif = exifEntries.length > 0;
  const hasGpsIfd = gpsEntries.length > 0;
  const n0 = ifd0Entries.length + (hasExif ? 1 : 0) + (hasGpsIfd ? 1 : 0);
  const ifd0Size = 2 + 12 * n0 + 4 + ifdExtraLen(ifd0Entries);
  const exifOffset = 8 + ifd0Size;
  const exifSize = hasExif
    ? 2 + 12 * exifEntries.length + 4 + ifdExtraLen(exifEntries)
    : 0;
  const gpsOffset = exifOffset + exifSize;

  if (hasExif) ifd0Entries.push(entry(0x8769, T_LONG, 1, le32(exifOffset)));
  if (hasGpsIfd) ifd0Entries.push(entry(0x8825, T_LONG, 1, le32(gpsOffset)));

  const ifd0 = serializeIfd(ifd0Entries, 8, 0);
  const exifIfd = hasExif ? serializeIfd(exifEntries, exifOffset, 0) : new Uint8Array(0);
  const gpsIfd = hasGpsIfd ? serializeIfd(gpsEntries, gpsOffset, 0) : new Uint8Array(0);

  const header = new Uint8Array(8);
  const hdv = new DataView(header.buffer);
  header[0] = 0x49; // "II" little-endian
  header[1] = 0x49;
  hdv.setUint16(2, 0x002a, true);
  hdv.setUint32(4, 8, true); // IFD0 offset
  const tiff = u8concat([header, ifd0, exifIfd, gpsIfd]);

  const payload = u8concat([
    new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), // "Exif\0\0"
    tiff,
  ]);
  const segLen = 2 + payload.length;
  if (segLen > 0xffff) return null;
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff;
  seg[1] = 0xe1; // APP1
  seg[2] = (segLen >> 8) & 0xff;
  seg[3] = segLen & 0xff;
  seg.set(payload, 4);
  return seg;
}

// ---------------------------------------------------------------------------
// JPEG embedding
// ---------------------------------------------------------------------------

const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

// Wrap an XMP packet in its APP1 segment, or null if it won't fit one segment.
function buildXmpApp1(xmpXml) {
  const enc = new TextEncoder();
  const headerBytes = enc.encode(XMP_HEADER);
  const xmpBytes = enc.encode(xmpXml);
  const segLen = 2 + headerBytes.length + xmpBytes.length;
  if (segLen > 0xffff) return null;
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (segLen >> 8) & 0xff;
  seg[3] = segLen & 0xff;
  seg.set(headerBytes, 4);
  seg.set(xmpBytes, 4 + headerBytes.length);
  return seg;
}

/**
 * Embed `meta` into JPEG `bytes`: a binary EXIF APP1 (date/GPS/caption/creator —
 * what OS file browsers and photo apps read) followed by an XMP APP1 (keywords,
 * alt text, link, location name). Both go right after SOI, EXIF first (readers
 * expect the Exif APP1 first). Returns a new Uint8Array, or null if the bytes
 * aren't a JPEG (e.g. webp) or there's nothing to embed — caller saves untouched.
 */
function embedMetadataInJpeg(bytes, meta) {
  if (!bytes || bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null; // not a JPEG (SOI = FF D8)
  }
  if (!meta) return null;

  const segs = [];
  const exif = buildExifApp1(meta);
  if (exif) segs.push(exif);
  const xmp = buildXmpApp1(buildXmpPacket(meta));
  if (xmp) segs.push(xmp);
  if (!segs.length) return null;

  const insert = u8concat(segs);
  const out = new Uint8Array(bytes.length + insert.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(insert, 2);
  out.set(bytes.subarray(2), 2 + insert.length);
  return out;
}

// ---------------------------------------------------------------------------
// Ogg (Opus / Vorbis) comment embedding — for DM voice notes (.ogg)
//
// A voice note can't take JPEG EXIF, so the in-file equivalent is the format's
// native comment header: OpusTags (Ogg/Opus) or the Vorbis comment packet. We
// rewrite *only* the comment-header page in place — same page sequence number,
// recomputed lacing + Ogg CRC — and bail (return null → caller saves the
// original untouched) on anything unusual, so a download is never corrupted.
// ---------------------------------------------------------------------------

// Ogg's CRC32: polynomial 0x04c11db7, init 0, NO bit reflection, no final xor.
// (Different from the zip/PNG CRC, which is reflected.)
let OGG_CRC_TABLE = null;
function oggCrcTable() {
  if (OGG_CRC_TABLE) return OGG_CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    t[i] = r >>> 0;
  }
  OGG_CRC_TABLE = t;
  return t;
}
function oggCrc(page) {
  const t = oggCrcTable();
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    crc = ((crc << 8) ^ t[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function u32le(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function pushU32le(arr, v) {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function asciiAt(b, o, s) {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

// Reassemble one Ogg page (recomputes lacing + CRC). Returns null if the payload
// would need more than one page (>255 lacing segments) — never our small tags.
function buildOggPage(headerType, granule8, serial, seq, payload) {
  const lacing = [];
  let rem = payload.length;
  while (rem >= 255) {
    lacing.push(255);
    rem -= 255;
  }
  lacing.push(rem);
  if (lacing.length > 255) return null;

  const page = new Uint8Array(27 + lacing.length + payload.length);
  page[0] = 0x4f; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53; // "OggS"
  page[4] = 0; // stream structure version
  page[5] = headerType;
  page.set(granule8, 6); // granule position (8 bytes)
  page[14] = serial & 0xff; page[15] = (serial >>> 8) & 0xff;
  page[16] = (serial >>> 16) & 0xff; page[17] = (serial >>> 24) & 0xff;
  page[18] = seq & 0xff; page[19] = (seq >>> 8) & 0xff;
  page[20] = (seq >>> 16) & 0xff; page[21] = (seq >>> 24) & 0xff;
  // CRC (22..25) left zero while computing.
  page[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) page[27 + i] = lacing[i];
  page.set(payload, 27 + lacing.length);

  const crc = oggCrc(page);
  page[22] = crc & 0xff; page[23] = (crc >>> 8) & 0xff;
  page[24] = (crc >>> 16) & 0xff; page[25] = (crc >>> 24) & 0xff;
  return page;
}

// Walk Ogg pages until we have the first few (enough to find the comment header).
function parseOggPages(bytes, max) {
  const pages = [];
  let o = 0;
  while (o + 27 <= bytes.length && pages.length < max) {
    if (!asciiAt(bytes, o, "OggS")) break;
    const headerType = bytes[o + 5];
    const numSeg = bytes[o + 26];
    const segStart = o + 27;
    if (segStart + numSeg > bytes.length) break;
    let payloadLen = 0;
    for (let i = 0; i < numSeg; i++) payloadLen += bytes[segStart + i];
    const payloadStart = segStart + numSeg;
    const pageEnd = payloadStart + payloadLen;
    if (pageEnd > bytes.length) break;
    pages.push({
      start: o, headerType, numSeg, lacing: bytes.subarray(segStart, segStart + numSeg),
      payloadStart, payloadLen, pageEnd,
    });
    o = pageEnd;
  }
  return pages;
}

/**
 * Embed `meta` (title/artist/date/description/link) into an Ogg/Opus or
 * Ogg/Vorbis `.ogg` as native comment tags. Returns new bytes, or null when the
 * stream isn't a clean single-packet comment header we can safely rewrite — the
 * caller then saves the original file unchanged.
 */
function embedMetadataInOgg(bytes, meta) {
  try {
    if (!bytes || bytes.length < 28 || !asciiAt(bytes, 0, "OggS")) return null;
    if (!meta) return null;

    const pages = parseOggPages(bytes, 4);
    if (pages.length < 2) return null;

    // Find the comment-header page: Opus → payload starts "OpusTags"; Vorbis →
    // 0x03 "vorbis".
    let ci = -1, kind = null;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (asciiAt(bytes, p.payloadStart, "OpusTags")) { ci = i; kind = "opus"; break; }
      if (bytes[p.payloadStart] === 0x03 && asciiAt(bytes, p.payloadStart + 1, "vorbis")) {
        ci = i; kind = "vorbis"; break;
      }
    }
    if (ci === -1) return null;

    const cp = pages[ci];
    // Only rewrite when this page holds exactly ONE complete packet (one lacing
    // terminator <255, as the final segment, and not continued from a prior
    // page). Anything else (comment shares a page with setup data, etc.) → bail.
    if (cp.headerType & 0x01) return null;
    let terminators = 0;
    for (let i = 0; i < cp.numSeg; i++) if (cp.lacing[i] < 255) terminators++;
    if (terminators !== 1 || cp.lacing[cp.numSeg - 1] === 255) return null;

    const payload = bytes.subarray(cp.payloadStart, cp.payloadStart + cp.payloadLen);
    const magicLen = kind === "opus" ? 8 : 7;
    let off = magicLen;
    if (off + 4 > payload.length) return null;
    const vlen = u32le(payload, off); off += 4;
    if (off + vlen + 4 > payload.length) return null;
    const vendor = payload.subarray(off, off + vlen); off += vlen;
    const count = u32le(payload, off); off += 4;

    const existing = [];
    for (let i = 0; i < count; i++) {
      if (off + 4 > payload.length) return null;
      const ln = u32le(payload, off); off += 4;
      if (off + ln > payload.length) return null;
      existing.push(payload.subarray(off, off + ln)); off += ln;
    }

    const enc = new TextEncoder();
    const ours = [];
    const add = (k, v) => { if (v) ours.push(enc.encode(`${k}=${v}`)); };
    add("TITLE", meta.title);
    add("ARTIST", meta.artist);
    add("DATE", meta.date);
    add("DESCRIPTION", meta.description);
    add("COMMENT", meta.description);
    add("CONTACT", meta.link);
    add("ORGANIZATION", "Instagram");

    // Drop any existing tags whose key we're setting, so re-runs don't duplicate.
    const ourKeys = new Set(["TITLE", "ARTIST", "DATE", "DESCRIPTION", "COMMENT", "CONTACT", "ORGANIZATION"]);
    const dec = new TextDecoder();
    const kept = existing.filter((c) => {
      const s = dec.decode(c);
      const eq = s.indexOf("=");
      const key = (eq >= 0 ? s.slice(0, eq) : s).toUpperCase();
      return !ourKeys.has(key);
    });
    const comments = kept.concat(ours);

    const out = [];
    for (let i = 0; i < magicLen; i++) out.push(payload[i]);
    pushU32le(out, vendor.length);
    for (let i = 0; i < vendor.length; i++) out.push(vendor[i]);
    pushU32le(out, comments.length);
    for (const c of comments) {
      pushU32le(out, c.length);
      for (let i = 0; i < c.length; i++) out.push(c[i]);
    }
    if (kind === "vorbis") out.push(0x01); // framing bit
    const newPayload = new Uint8Array(out);

    const granule = bytes.subarray(cp.start + 6, cp.start + 14);
    const serial = u32le(bytes, cp.start + 14);
    const seq = u32le(bytes, cp.start + 18);
    const newPage = buildOggPage(cp.headerType, granule, serial, seq, newPayload);
    if (!newPage) return null;

    const result = new Uint8Array(cp.start + newPage.length + (bytes.length - cp.pageEnd));
    result.set(bytes.subarray(0, cp.start), 0);
    result.set(newPage, cp.start);
    result.set(bytes.subarray(cp.pageEnd), cp.start + newPage.length);
    return result;
  } catch (_) {
    return null;
  }
}




module.exports.extractMetadata = extractMetadata;
module.exports.profileMetadata = profileMetadata;
module.exports.buildXmpPacket = buildXmpPacket;
module.exports.buildExifApp1 = buildExifApp1;
module.exports.embedMetadataInJpeg = embedMetadataInJpeg;
module.exports.embedMetadataInOgg = embedMetadataInOgg;
module.exports.isEmptyMetadata = isEmptyMetadata;
});


defineModule("features/_shared/dm-message-actions.js", function (module, exports, require) {
/**
 * Shared DM message action helpers.
 *
 * Instagram's DM DOM no longer uses role="row" / data-scope="messages_table" /
 * "Double tap to like" buttons. Each message is now wrapped in
 * `[role="group"][tabindex="-1"]`, the bubble is a `[role="presentation"]`
 * element, and the hover action bar lives in a `div[style*="--x-width: 96px"]`
 * placeholder inside the group. The on-hover buttons and the popup menus still
 * expose stable aria-labels ("React to message…", "Reply to message…",
 * "See more options…", "Edit", and the ❤️ as the first reaction), so the
 * click pipelines are driven off those.
 *
 * Everything here is built to be instant and flash-free: action buttons and
 * popup dialogs are hidden the moment they are added to the DOM (before paint),
 * the real handler is invoked directly via the React fiber, then visibility is
 * restored.
 */

// A single message bubble. Old DOM fallback kept for safety.
const MESSAGE_GROUP_SELECTOR = '[role="group"][tabindex="-1"], [role="row"]';

// Bare `window` here is NOT reliably the real page window: this module runs
// as a normal (non-toPageScript) part of the userscript bundle, and in a
// Tampermonkey/Violentmonkey sandbox -- Firefox in particular -- unqualified
// `window` is a sandbox wrapper, not the actual platform Window object.
// Constructing a MouseEvent/PointerEvent with `view` set to that wrapper
// throws ("'view' member of UIEventInit does not implement interface
// Window") the moment Firefox's WebIDL layer checks it, which is exactly
// what broke every synthetic hover/click dispatch in this file. __realWindow
// is declared once in shim/02-page-inject.js and is in lexical scope here
// since this module is concatenated into that same bundle.
function realView() {
  return typeof __realWindow !== "undefined" ? __realWindow : window;
}

// The quick reply/edit keyboard shortcuts must only fire when the user is
// actually typing in a DM composer — not globally, and not just on /direct/
// (the docked DM widget in the bottom-right corner appears on any page, and the
// shortcuts should work there too). The composer is the contenteditable inside
// Instagram's IGDComposer pagelet; the docked widget reuses the same component.
// Checked at event time (listeners register once at document_start, but this is
// an SPA and focus moves around).
function isDmComposerFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const editable =
    el.isContentEditable ||
    el.tagName === "TEXTAREA" ||
    el.getAttribute?.("role") === "textbox";
  if (!editable) return false;

  // Quick positive: focused inside the IGDComposer pagelet, or a field whose
  // label reads "Message…".
  if (el.closest('[data-pagelet^="IGDComposer"]')) return true;
  const label = (
    el.getAttribute("aria-label") ||
    el.getAttribute("aria-placeholder") ||
    el.getAttribute("placeholder") ||
    ""
  ).trim();
  if (/^message/i.test(label)) return true;

  // Fallback that works in the docked DM widget (whose composer doesn't carry
  // the pagelet): an editable field with an open conversation present. Message
  // group detection is the same signal double-tap-to-like relies on, so it's
  // known-good wherever a DM thread is actually open.
  return getMessageGroups().length > 0;
}

const HIDE_STYLE_ID = "instafn-dm-action-hide-style";

// SVG labels for the three on-hover buttons (suffixed with "from <name>").
const REACT_SVG = 'svg[aria-label^="React to message"]';
const REPLY_SVG = 'svg[aria-label^="Reply to message"]';
const MORE_SVG = 'svg[aria-label^="See more options"]';

// -------------------------------------------------------------------------
// No-flash hide / restore
// -------------------------------------------------------------------------

function ensureHideStyle() {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  style.textContent = `[data-instafn-hiding="true"]{opacity:0 !important;visibility:hidden !important;transition:none !important;pointer-events:none !important;}`;
  document.head.appendChild(style);

  // One-time sweep on first use in this page load: a guard from a previous
  // (buggy) version of this module could have set data-instafn-hiding="true"
  // on a still-live DOM node and never cleared it -- that attribute is state
  // on the actual page element, so it survives a userscript update even
  // though the *code* is now fixed, and would otherwise look exactly like
  // the bug recurring. Only needed once per page load, right as the style
  // (and therefore the hiding behavior) is first wired up.
  document.querySelectorAll('[data-instafn-hiding="true"]').forEach((el) => {
    delete el.dataset.instafnHiding;
  });
}

function hideEl(el, hidden) {
  if (!el || el.dataset.instafnHiding === "true") return;
  el.dataset.instafnHiding = "true";
  hidden.push(el);
}

function restore(hidden) {
  hidden.forEach((el) => {
    if (el && el.dataset.instafnHiding === "true") delete el.dataset.instafnHiding;
  });
  hidden.length = 0;
}

// Is this a transient element we want to keep invisible (hover action bar or
// popup menu / reaction panel)? Deliberately narrow so we never touch main UI.
function isTransientActionEl(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.matches?.('[role="dialog"]')) return true;
  // The on-hover action bar gets the 3 buttons injected into it.
  if (node.querySelector?.(`${REACT_SVG}, ${REPLY_SVG}, ${MORE_SVG}`)) return true;
  return false;
}

/**
 * Watches the DOM and instantly hides any hover action bar or popup menu the
 * moment Instagram inserts it, so the user never sees a flash. Returns the
 * MutationObserver plus the shared `hidden` list used for restoring.
 */
function startFlashGuard() {
  ensureHideStyle();
  const hidden = [];

  // Hide anything already present.
  document
    .querySelectorAll(`[role="dialog"], ${REACT_SVG}, ${REPLY_SVG}, ${MORE_SVG}`)
    .forEach((el) => {
      const target = el.closest('[role="dialog"]') || el.closest('[role="button"]') || el;
      if (isTransientActionEl(target) || target.closest('[role="dialog"]')) hideEl(target, hidden);
    });

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (isTransientActionEl(node)) hideEl(node, hidden);
        // Action buttons injected inside an existing hover bar.
        node.querySelectorAll?.(`${REACT_SVG}, ${REPLY_SVG}, ${MORE_SVG}`).forEach((svg) => {
          const btn = svg.closest('[role="button"]');
          if (btn) hideEl(btn, hidden);
        });
        node.querySelectorAll?.('[role="dialog"]').forEach((d) => hideEl(d, hidden));
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Absolute failsafe on top of the try/finally in reactToMessage/
  // replyToMessage/editMessage: those guarantee stopFlashGuard() runs on
  // every code path we know about, but "every path we know about" is
  // exactly the kind of claim that's been wrong before in this file. If
  // something disconnects the observer without ever calling restore() --
  // a bug we haven't found yet, a future Instagram DOM change, anything --
  // this guarantees the row can never stay invisible for more than 2s
  // instead of indefinitely.
  const failsafeTimer = setTimeout(() => {
    observer.disconnect();
    restore(hidden);
  }, 2000);

  return { observer, hidden, failsafeTimer };
}

function stopFlashGuard(guard, { delay = 250 } = {}) {
  if (!guard) return;
  clearTimeout(guard.failsafeTimer);
  guard.observer?.disconnect();
  setTimeout(() => restore(guard.hidden), delay);
}

// -------------------------------------------------------------------------
// Message discovery
// -------------------------------------------------------------------------

function getThreadContainer() {
  // The open conversation's message list. (The virtualized list wraps each
  // message in its own `.x13dflua` item, so we must anchor on the list itself
  // rather than inferring a common parent of the message groups.)
  return (
    document.querySelector('[data-pagelet="IGDMessagesList"]') ||
    document.querySelector('[data-pagelet="IGDOpenMessageList"]') ||
    document.querySelector('[aria-label*="Messages in conversation"]') ||
    document.body
  );
}

/** All message groups in the open thread, oldest first (DOM order). */
function getMessageGroups() {
  const container = getThreadContainer();
  return Array.from(container.querySelectorAll(MESSAGE_GROUP_SELECTOR)).filter(
    (g) =>
      g.querySelector('[role="presentation"]') ||
      g.querySelector('a[aria-label^="Open the profile page"]') ||
      g.querySelector("img")
  );
}

// The deepest stable element to aim hover/pointer events at. Events dispatched
// here bubble UP through every ancestor that owns the hover handler (the row,
// the group), which is what makes Instagram render the action bar. Dispatching
// on the group alone does not reach the child row that listens for the hover.
function getHoverTarget(group) {
  return (
    group.querySelector('[role="presentation"]') ||
    group.querySelector('[role="none"] > div') ||
    group.firstElementChild ||
    group
  );
}

/**
 * Sent vs received, detected by horizontal alignment (class-independent and
 * resilient to Instagram's obfuscated class churn). Received messages also
 * carry the sender's avatar link, which is treated as a definitive signal.
 */
function isSentMessage(group) {
  if (group.querySelector('a[aria-label^="Open the profile page"]')) return false;
  const bubble = group.querySelector('[role="presentation"]') || group.firstElementChild;
  if (!bubble) return true;
  const gr = group.getBoundingClientRect();
  const br = bubble.getBoundingClientRect();
  if (!gr.width || !br.width) return true;
  const leftGap = br.left - gr.left;
  const rightGap = gr.right - br.right;
  return rightGap <= leftGap; // hugs the right edge => sent by us
}

/** Last message we sent (most recent), or null. */
function findLastSentMessage() {
  const groups = getMessageGroups();
  for (let i = groups.length - 1; i >= 0; i--) {
    if (isSentMessage(groups[i])) return groups[i];
  }
  return null;
}

/** All messages from the other person, most recent first. */
function findOtherPersonMessages() {
  return getMessageGroups()
    .filter((g) => !isSentMessage(g))
    .reverse();
}

// -------------------------------------------------------------------------
// Hover + click
// -------------------------------------------------------------------------

function triggerHover(element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  ["mouseenter", "mouseover", "mousemove", "pointerenter", "pointerover"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    element.dispatchEvent(
      new EventClass(type, { bubbles: true, cancelable: true, view: realView(), clientX, clientY })
    );
  });
}

// Collapse the hover action bar so it doesn't stay stuck on the message after a
// synthetic hover (we never sent a real mouseleave). Aim at the same deep target
// we hovered so the bubbling mouseout reaches the row that owns the handler.
function triggerUnhover(group) {
  const target = getHoverTarget(group);
  ["mouseout", "mouseleave", "pointerout", "pointerleave"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    target.dispatchEvent(
      new EventClass(type, { bubbles: true, cancelable: true, view: realView() })
    );
  });
}

function findReactFiber(dom) {
  if (!dom) return null;
  for (const key in dom) {
    if (
      key.startsWith("__reactFiber") ||
      key.startsWith("__reactInternalInstance") ||
      key.startsWith("__reactContainer")
    ) {
      return dom[key];
    }
  }
  return null;
}

function findClickHandler(element) {
  let node = element;
  let depth = 0;
  while (node && depth < 4) {
    const fiber = findReactFiber(node);
    let f = fiber;
    let hops = 0;
    while (f && hops < 6) {
      const props = f.memoizedProps || f.pendingProps;
      // Quick-reaction chips in the dialog are plain divs (not <button>),
      // and this style of "zero-latency" picker commonly fires on
      // pointerdown/mousedown rather than click, so the click actually
      // registering nothing visually was never a heart-detection problem --
      // findClickHandler was only ever looking for onClick.
      if (props?.onClick) return { handler: props.onClick.bind(null), type: "click" };
      if (props?.onPointerDown) return { handler: props.onPointerDown.bind(null), type: "pointerdown" };
      if (props?.onMouseDown) return { handler: props.onMouseDown.bind(null), type: "mousedown" };
      f = f.return;
      hops++;
    }
    if (typeof node.onclick === "function") return { handler: node.onclick.bind(node), type: "click" };
    node = node.parentElement;
    depth++;
  }
  return null;
}

/** Click a button instantly via its React handler, falling back to synthetic events. */
function clickInstantly(button, callback) {
  const found = findClickHandler(button);
  if (found) {
    try {
      const EventClass = found.type.startsWith("pointer") ? PointerEvent : MouseEvent;
      found.handler(
        new EventClass(found.type, {
          bubbles: true,
          cancelable: true,
          view: realView(),
          detail: 1,
          button: 0,
        })
      );
      if (callback) callback();
      return;
    } catch (e) {
      /* fall through to synthetic events */
    }
  }

  const rect = button.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  // Include pointerdown/pointerup alongside mousedown/mouseup/click -- the
  // dialog's quick-reaction chips are plain divs that fire on pointerdown
  // for a zero-latency feel, and dispatching only mouse events never
  // reached that handler even though the click event itself landed fine.
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    button.dispatchEvent(
      new EventClass(type, {
        bubbles: true,
        cancelable: true,
        view: realView(),
        clientX,
        clientY,
        button: 0,
        detail: 1,
      })
    );
  });
  button.click?.();
  if (callback) callback();
}

// Poll for an element (Instagram renders the menu a frame or two after hover/click).
function waitFor(getter, { maxAttempts = 20, interval = 30 } = {}) {
  return new Promise((resolve) => {
    let attempts = 0;
    const tick = () => {
      attempts++;
      // A throwing getter used to reject this promise outright, bypassing
      // even a try/finally in the caller if it happened on the very first
      // (synchronous) tick -- since that throw would escape before the
      // caller's own try block is entered. Resolving to null on error keeps
      // this a plain "not found" outcome instead of an escaping exception,
      // so callers' cleanup always runs.
      let found;
      try {
        found = getter();
      } catch (err) {
        console.error("[Instafn] waitFor getter threw:", err);
        return resolve(null);
      }
      if (found) return resolve(found);
      if (attempts >= maxAttempts) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

function buttonFrom(svgSelector, scope) {
  const svg =
    scope.querySelector(svgSelector) ||
    scope.parentElement?.querySelector(svgSelector) ||
    scope.closest('[role="row"], [role="group"]')?.querySelector(svgSelector);
  return svg ? svg.closest('[role="button"]') : null;
}

// -------------------------------------------------------------------------
// Pipelines
// -------------------------------------------------------------------------

/** Double-tap to like: react to `group` with the heart (first reaction). */
async function reactToMessage(group) {
  const guard = startFlashGuard();
  // The whole pipeline used to unhide (stopFlashGuard) only at each explicit
  // return point. That's exactly the kind of thing that's fragile against
  // Instagram DOM changes: if any step here throws instead of cleanly
  // returning null/false (e.g. a selector match that no longer holds), the
  // function aborts mid-pipeline and NEVER reaches triggerUnhover/
  // stopFlashGuard -- leaving the hover row's react/reply/more icons stuck
  // at opacity:0 (which is what the flash guard's hide style enforces)
  // permanently, since nothing else ever clears that dataset attribute.
  // try/finally guarantees cleanup runs on every exit path, including a
  // thrown error, so a failed react at worst does nothing instead of
  // wedging the row.
  try {
    triggerHover(getHoverTarget(group));

    const reactBtn = await waitFor(() => buttonFrom(REACT_SVG, group));
    if (!reactBtn) return false;
    clickInstantly(reactBtn);

    const heart = await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const buttons = Array.from(dialog.querySelectorAll('[role="button"]'));
      // Prefer the literal heart. Instagram doesn't always render reaction
      // emoji as plain unicode text -- it's also seen rendering them as an
      // <img> sprite (alt="❤️" / aria-label mentioning "heart") for consistent
      // cross-platform glyphs, which leaves textContent empty and breaks both
      // this match and the length<=2 fallback below (an empty string fails
      // the `text &&` guard, and no button textContent-includes-❤ anywhere).
      const explicit = buttons.find(
        (b) =>
          (b.textContent || "").includes("❤") ||
          /heart/i.test(b.getAttribute("aria-label") || "") ||
          [...b.querySelectorAll("img")].some((img) =>
            (img.getAttribute("alt") || "").includes("❤")
          )
      );
      if (explicit) return explicit;
      return buttons.find((b) => {
        if (b.querySelector('svg[aria-label="Choose an emoji"]')) return false;
        const text = b.querySelector("span")?.textContent?.trim() || "";
        return text && [...text].length <= 2;
      });
    });

    if (heart) clickInstantly(heart);
    return !!heart;
  } catch (err) {
    console.error("[Instafn] reactToMessage failed:", err);
    return false;
  } finally {
    triggerUnhover(group);
    stopFlashGuard(guard);
  }
}

/** Quick reply: open the reply composer for `group` (single click, no submenu). */
async function replyToMessage(group) {
  const guard = startFlashGuard();
  try {
    triggerHover(getHoverTarget(group));
    const replyBtn = await waitFor(() => buttonFrom(REPLY_SVG, group));
    if (replyBtn) clickInstantly(replyBtn);
    return !!replyBtn;
  } catch (err) {
    console.error("[Instafn] replyToMessage failed:", err);
    return false;
  } finally {
    triggerUnhover(group);
    stopFlashGuard(guard);
  }
}

/** Quick edit: open the "See more options" menu for `group` and click Edit. */
async function editMessage(group) {
  const guard = startFlashGuard();
  try {
    triggerHover(getHoverTarget(group));

    const moreBtn = await waitFor(
      () =>
        buttonFrom(MORE_SVG, group) ||
        group.querySelector('[role="button"][aria-haspopup="menu"]')
    );
    if (!moreBtn) return false;
    clickInstantly(moreBtn);

    const editBtn = await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      return (
        dialog.querySelector('svg[aria-label="Edit"]')?.closest('[role="button"]') ||
        Array.from(dialog.querySelectorAll('[role="button"]')).find(
          (b) => b.textContent?.trim() === "Edit"
        ) ||
        null
      );
    });

    if (editBtn) {
      clickInstantly(editBtn);
      return true;
    }

    // Couldn't find Edit — close the menu so we don't leave it dangling.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
    );
    return false;
  } catch (err) {
    console.error("[Instafn] editMessage failed:", err);
    return false;
  } finally {
    triggerUnhover(group);
    stopFlashGuard(guard);
  }
}


module.exports.MESSAGE_GROUP_SELECTOR = MESSAGE_GROUP_SELECTOR;
module.exports.isDmComposerFocused = isDmComposerFocused;
module.exports.startFlashGuard = startFlashGuard;
module.exports.stopFlashGuard = stopFlashGuard;
module.exports.getMessageGroups = getMessageGroups;
module.exports.isSentMessage = isSentMessage;
module.exports.findLastSentMessage = findLastSentMessage;
module.exports.findOtherPersonMessages = findOtherPersonMessages;
module.exports.triggerHover = triggerHover;
module.exports.clickInstantly = clickInstantly;
module.exports.reactToMessage = reactToMessage;
module.exports.replyToMessage = replyToMessage;
module.exports.editMessage = editMessage;
});


defineModule("features/profile-follow-indicator/index.js", function (module, exports, require) {
var { getProfileUsernameFromPath } = require("features/follow-analyzer/logic.js");
var { injectStylesheet } = require("utils/styleLoader.js");

const INDICATOR_ID = "instafn-follow-indicator";
let isEnabled = false;
let currentUsername = null;
let followStatusCache = new Map();
let retryCount = 0;
let urlObserver = null;
let domObserver = null;
let messageListenerSetup = false;
let messageListenerHandler = null;

const MAX_RETRIES = 10;
const POST_PAGE_REGEX = /^\/p\/[^\/]+\/?$/;
const REEL_PAGE_REGEX = /^\/reel\/[^\/]+\/?$/;

function createIndicator(text) {
  const indicator = document.createElement("div");
  indicator.id = INDICATOR_ID;
  indicator.textContent = text;
  return indicator;
}

function findStatsContainer() {
  for (const container of document.querySelectorAll("div.x40hh3e")) {
    const text = container.textContent || "";
    if (
      text.includes("post") &&
      text.includes("follower") &&
      text.includes("following") &&
      /\d+/.test(text) &&
      container.children.length >= 3
    ) {
      return container;
    }
  }
  return null;
}

function isOwnProfile() {
  return (
    document.querySelector('a[href*="/accounts/edit/"]') ||
    Array.from(document.querySelectorAll("*")).some(
      (el) =>
        el.textContent?.includes("Edit profile") ||
        el.textContent?.includes("Edit Profile")
    )
  );
}

function isPostOrReelPage() {
  return (
    POST_PAGE_REGEX.test(location.pathname) ||
    REEL_PAGE_REGEX.test(location.pathname)
  );
}

function extractFollowStatus(data) {
  if (!isEnabled) return;
  try {
    // Handle different GraphQL response formats
    // Format 1: { data: { user: { ... } } }
    // Format 2: { data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [{ node: { user: { ... } } }] } } }
    // Format 3: Wrapped in additional layers
    
    let user = null;
    let username = null;
    let followedBy = undefined;
    
    // Try direct path first
    if (data?.data?.user) {
      user = data.data.user;
    }
    // Try nested in edges (common in Instagram responses)
    else if (data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges?.[0]?.node?.user) {
      user = data.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[0].node.user;
    }
    // Try other common paths
    else if (data?.data?.user_dict) {
      // Sometimes user data is in user_dict
      const userDict = data.data.user_dict;
      if (typeof userDict === 'object' && Object.keys(userDict).length > 0) {
        // Get first user in dict
        const firstKey = Object.keys(userDict)[0];
        user = userDict[firstKey];
      }
    }
    
    if (user) {
      username = user.username || user.user?.username;
      followedBy = user.friendship_status?.followed_by ?? 
                   user.user?.friendship_status?.followed_by ??
                   user.followed_by;
    }
    
    if (username && followedBy !== undefined) {
      console.log(`[Instafn Follow Indicator] Found follow status for ${username}: ${followedBy}`);
      followStatusCache.set(username, followedBy);
      if (getProfileUsernameFromPath() === username) {
        setTimeout(() => injectFollowIndicator(), 100);
      }
    } else if (username) {
      console.log(`[Instafn Follow Indicator] Found username ${username} but no follow status`);
    }
  } catch (e) {
    console.error("[Instafn] Error extracting follow status:", e, data);
  }
}

function setupGraphQLMessageListener() {
  // Bare `window` here is NOT reliably the real page window: this is a
  // regular (non-toPageScript) module in the userscript bundle, and in a
  // Tampermonkey/Violentmonkey sandbox -- Firefox especially -- bare
  // `window` is a sandbox wrapper distinct from the real page window.
  // graphql-sniffer.js (the sender) IS toPageScript-wrapped and posts via
  // the real page window, so both listening on bare `window` and checking
  // `event.source === window` failed here: the listener was attached to a
  // different window object than the one the message was posted to (never
  // even firing), and the source check would have failed anyway even if it
  // had. Follow-status responses were silently dropped every time, and
  // this always fell through to the 3s "FAILED TO FETCH" timeout.
  // __realWindow is declared once in shim/02-page-inject.js and is in
  // scope here since this module is concatenated into that same bundle.
  const realWindow = typeof __realWindow !== "undefined" ? __realWindow : window;

  // Remove existing listener if any
  if (messageListenerHandler) {
    realWindow.removeEventListener("message", messageListenerHandler);
  }

  messageListenerHandler = (event) => {
    if (!isEnabled) return;
    if (
      event.source === realWindow &&
      event.data?.source === "instafn-graphql" &&
      event.data.type === "graphql-response" &&
      event.data.isProfileRequest
    ) {
      console.log("[Instafn Follow Indicator] Received GraphQL profile response");
      try {
        // Try parsing as JSON first
        let parsedData = event.data.data;
        if (typeof parsedData === 'string') {
          parsedData = JSON.parse(parsedData);
        }
        extractFollowStatus(parsedData);
      } catch (e) {
        console.log("[Instafn Follow Indicator] Failed to parse as JSON, trying regex extraction");
        try {
          // Try to extract JSON from string that might contain other text
          const match = event.data.data.match(/\{[\s\S]*"data"[\s\S]*\}/);
          if (match) {
            extractFollowStatus(JSON.parse(match[0]));
          } else {
            console.warn("[Instafn Follow Indicator] Could not extract JSON from response");
            // Still try to inject indicator after delay in case data comes later
            if (isEnabled) {
              setTimeout(() => injectFollowIndicator(), 2000);
            }
          }
        } catch (parseErr) {
          console.error("[Instafn Follow Indicator] Error parsing GraphQL response:", parseErr);
          // Still try to inject indicator after delay
          if (isEnabled) {
            setTimeout(() => injectFollowIndicator(), 2000);
          }
        }
      }
    }
  };

  realWindow.addEventListener("message", messageListenerHandler);
}

function injectFollowIndicator() {
  if (!isEnabled) return;
  const username = getProfileUsernameFromPath();
  const existing = document.getElementById(INDICATOR_ID);

  // Not on profile page
  if (!username) {
    if (existing && currentUsername && !isPostOrReelPage()) {
      existing.remove();
      currentUsername = null;
    }
    return;
  }

  // Own profile
  if (isOwnProfile()) {
    if (existing) existing.remove();
    currentUsername = null;
    return;
  }

  // Same profile - just update text
  if (existing && (currentUsername === username || !currentUsername)) {
    currentUsername = username;
    const followsYou = followStatusCache.get(username);
    if (followsYou !== undefined) {
      existing.textContent = followsYou ? "FOLLOWS YOU" : "NOT FOLLOWING YOU";
    }
    return;
  }

  // Different profile or new injection
  if (currentUsername !== username) retryCount = 0;
  currentUsername = username;

  const statsContainer = findStatsContainer();
  if (!statsContainer) {
    if (existing) return; // Keep existing indicator
    if (++retryCount > MAX_RETRIES) {
      retryCount = 0;
      return;
    }
    setTimeout(injectFollowIndicator, 500);
    return;
  }

  retryCount = 0;
  if (existing && currentUsername !== username) existing.remove();

  const followsYou = followStatusCache.get(username);
  const indicator = createIndicator(
    followsYou === undefined
      ? "FETCHING..."
      : followsYou
      ? "FOLLOWS YOU"
      : "NOT FOLLOWING YOU"
  );

  if (statsContainer.parentElement) {
    statsContainer.parentElement.insertBefore(
      indicator,
      statsContainer.nextSibling
    );
  }

  if (followsYou === undefined) {
    setTimeout(() => {
      if (!isEnabled) return;
      const cachedStatus = followStatusCache.get(username);
      const existing = document.getElementById(INDICATOR_ID);
      if (existing) {
        existing.textContent =
          cachedStatus === undefined
            ? "FAILED TO FETCH"
            : cachedStatus
            ? "FOLLOWS YOU"
            : "NOT FOLLOWING YOU";
      }
    }, 3000);
  }
}

function setupGraphQLMessageListenerEarly() {
  if (messageListenerSetup) return;
  messageListenerSetup = true;
  // Only set up the listener if the feature is enabled
  chrome.storage.sync.get(
    { enableProfileFollowIndicator: false },
    (settings) => {
      if (settings.enableProfileFollowIndicator) {
        isEnabled = true;
        setupGraphQLMessageListener();
      }
    }
  );
}

function initProfileFollowIndicator() {
  isEnabled = true;

  injectStylesheet(
    "content/features/profile-follow-indicator/profile-follow-indicator.css"
  );

  // Set up message listener if not already set up or if it was removed
  if (!messageListenerHandler) {
    setupGraphQLMessageListener();
  }
  if (!messageListenerSetup) {
    messageListenerSetup = true;
  }

  injectFollowIndicator();
  setTimeout(injectFollowIndicator, 500);
  setTimeout(injectFollowIndicator, 1500);

  let lastUrl = location.href;
  let lastProfileUsername = getProfileUsernameFromPath();

  urlObserver = new MutationObserver(() => {
    if (!isEnabled) return;
    if (location.href !== lastUrl) {
      const newProfileUsername = getProfileUsernameFromPath();
      lastUrl = location.href;

      if (isPostOrReelPage()) return;

      if (newProfileUsername !== lastProfileUsername) {
        lastProfileUsername = newProfileUsername;
        currentUsername = null;
        retryCount = 0;

        const existing = document.getElementById(INDICATOR_ID);
        if (!newProfileUsername) {
          if (existing) existing.remove();
        } else {
          setTimeout(injectFollowIndicator, 300);
        }
      }
    }
  });
  urlObserver.observe(document, { subtree: true, childList: true });

  domObserver = new MutationObserver(() => {
    if (!isEnabled) return;
    const username = getProfileUsernameFromPath();
    if (
      username &&
      !document.getElementById(INDICATOR_ID) &&
      !isOwnProfile() &&
      !isPostOrReelPage()
    ) {
      injectFollowIndicator();
    }
  });
  domObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}


module.exports.setupGraphQLMessageListenerEarly = setupGraphQLMessageListenerEarly;
module.exports.initProfileFollowIndicator = initProfileFollowIndicator;
});


defineModule("features/exact-time-display/index.js", function (module, exports, require) {
// Display exact time and date on all <time> elements instead of relative time (e.g., "2d" -> "Jan 1, 2026, 6:14 AM")

let observer = null;
let processedElements = new WeakSet();
let currentFormat = "default";
let currentEnabled = false;

const TOKEN_MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const TOKEN_MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const TOKEN_DAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const TOKEN_DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format a Date using brace tokens, e.g. "{MM}/{DD}/{YYYY} {h}:{mm} {A}".
 * Unknown {tokens} are left untouched so literal braces survive.
 *
 * NOTE: keep this token table in sync with formatTokens() in
 * src/settings/settings-shared.js, which powers the live preview in the
 * settings UI (the two live in different module systems).
 *
 * @param {Date} date - The date to format
 * @param {string} fmt - Format string containing {tokens}
 * @returns {string} Formatted date and time
 */
function formatWithTokens(date, fmt) {
  const pad = (n) => n.toString().padStart(2, "0");
  const year = date.getFullYear();
  const monthIdx = date.getMonth();
  const day = date.getDate();
  const dow = date.getDay();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const hour12 = hours % 12 || 12;
  const ampm = hours >= 12 ? "PM" : "AM";

  const map = {
    YYYY: year,
    YY: pad(year % 100),
    MMMM: TOKEN_MONTHS_LONG[monthIdx],
    MMM: TOKEN_MONTHS_SHORT[monthIdx],
    MM: pad(monthIdx + 1),
    M: monthIdx + 1,
    DD: pad(day),
    D: day,
    dddd: TOKEN_DAYS_LONG[dow],
    ddd: TOKEN_DAYS_SHORT[dow],
    HH: pad(hours),
    H: hours,
    hh: pad(hour12),
    h: hour12,
    mm: pad(minutes),
    m: minutes,
    ss: pad(seconds),
    s: seconds,
    A: ampm,
    a: ampm.toLowerCase(),
    time: `${hour12}:${pad(minutes)} ${ampm}`,
    date: `${TOKEN_MONTHS_SHORT[monthIdx]} ${day}, ${year}`,
  };

  return String(fmt).replace(/\{(\w+)\}/g, (full, token) =>
    token in map ? String(map[token]) : full
  );
}

/**
 * Format a datetime string based on the selected format
 * @param {string} datetime - ISO 8601 datetime string (e.g., "2026-01-01T06:14:52.000Z")
 * @param {string} format - Format identifier, or a custom brace-token string
 *   (e.g. "{MM}/{DD}/{YYYY} {h}:{mm} {A}")
 * @returns {string} Formatted date and time
 */
function formatExactTime(datetime, format = "default") {
  try {
    const date = new Date(datetime);
    if (isNaN(date.getTime())) {
      return datetime; // Return original if invalid
    }

    // Custom user format: anything containing a {token}. Legacy preset keys
    // (no braces) keep flowing through the switch below for back-compat.
    if (typeof format === "string" && format.includes("{")) {
      return formatWithTokens(date, format);
    }

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    const monthNamesShort = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];

    const pad = (n) => n.toString().padStart(2, "0");
    const hour12 = hours % 12 || 12;
    const ampm = hours >= 12 ? "PM" : "AM";

    switch (format) {
      case "default":
        // Jan 1, 2026, 6:14 AM
        return date.toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

      case "full":
        // January 1, 2026, 6:14:52 AM
        return date.toLocaleString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        });

      case "short":
        // 1/1/2026, 6:14 AM
        return date.toLocaleString("en-US", {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

      case "iso":
        // 2026-01-01 06:14:52
        return `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

      case "us":
        // 01/01/2026, 6:14 AM
        return `${pad(month)}/${pad(day)}/${year}, ${hour12}:${pad(minutes)} ${ampm}`;

      case "european":
        // 01/01/2026, 06:14
        return `${pad(day)}/${pad(month)}/${year}, ${pad(hours)}:${pad(minutes)}`;

      case "date-only":
        // Jan 1, 2026
        return date.toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });

      case "time-only":
        // 6:14 AM
        return date.toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

      case "24h":
        // Jan 1, 2026, 06:14
        return `${monthNamesShort[month - 1]} ${day}, ${year}, ${pad(hours)}:${pad(minutes)}`;

      case "24h-full":
        // January 1, 2026, 06:14:52
        return `${monthNames[month - 1]} ${day}, ${year}, ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

      case "relative-precise":
        // Show relative time with exact time in parentheses
        const now = new Date();
        const diffMs = Math.abs(now - date);
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        const diffWeeks = Math.floor(diffDays / 7);
        const diffMonths = Math.floor(diffDays / 30);
        const diffYears = Math.floor(diffDays / 365);

        const isFuture = date > now;
        let relative = "";
        if (diffYears > 0) relative = `${diffYears}y`;
        else if (diffMonths > 0) relative = `${diffMonths}mo`;
        else if (diffWeeks > 0) relative = `${diffWeeks}w`;
        else if (diffDays > 0) relative = `${diffDays}d`;
        else if (diffHours > 0) relative = `${diffHours}h`;
        else if (diffMins > 0) relative = `${diffMins}m`;
        else relative = `${diffSecs}s`;

        if (isFuture) relative = `in ${relative}`;

        // Return relative with exact time in parentheses
        const exact = date.toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return `${relative} (${exact})`;

      case "compact":
        // 1 Jan 2026, 6:14 AM
        return `${day} ${monthNamesShort[month - 1]} ${year}, ${hour12}:${pad(minutes)} ${ampm}`;

      case "rfc2822":
        // Mon, 01 Jan 2026 06:14:52 +0000
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const dayName = days[date.getDay()];
        const timezoneOffset = -date.getTimezoneOffset();
        const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
        const offsetMins = Math.abs(timezoneOffset) % 60;
        const offsetSign = timezoneOffset >= 0 ? "+" : "-";
        return `${dayName}, ${pad(day)} ${monthNamesShort[month - 1]} ${year} ${pad(hours)}:${pad(minutes)}:${pad(seconds)} ${offsetSign}${pad(offsetHours)}${pad(offsetMins)}`;

      // --- Numeric day/month formats with a truncated 2-digit year, plus
      // optional time. Shared with the Post Hover Info feature. ---
      case "dd/mm/yy":
        // 26/05/26
        return `${pad(day)}/${pad(month)}/${pad(year % 100)}`;
      case "dd/mm/yy-time":
        // 26/05/26, 3:02 PM
        return `${pad(day)}/${pad(month)}/${pad(year % 100)}, ${hour12}:${pad(minutes)} ${ampm}`;
      case "mm/dd/yy":
        // 05/26/26
        return `${pad(month)}/${pad(day)}/${pad(year % 100)}`;
      case "mm/dd/yy-time":
        // 05/26/26, 3:02 PM
        return `${pad(month)}/${pad(day)}/${pad(year % 100)}, ${hour12}:${pad(minutes)} ${ampm}`;
      case "dd/mm/yyyy":
        // 26/05/2026
        return `${pad(day)}/${pad(month)}/${year}`;
      case "dd/mm/yyyy-time":
        // 26/05/2026, 3:02 PM
        return `${pad(day)}/${pad(month)}/${year}, ${hour12}:${pad(minutes)} ${ampm}`;
      case "mm/dd/yyyy":
        // 05/26/2026
        return `${pad(month)}/${pad(day)}/${year}`;
      case "day-month":
        // 26 May 2026
        return `${day} ${monthNamesShort[month - 1]} ${year}`;
      case "day-month-time":
        // 26 May 2026, 3:02 PM
        return `${day} ${monthNamesShort[month - 1]} ${year}, ${hour12}:${pad(minutes)} ${ampm}`;

      default:
        // Fallback to default format
        return date.toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
    }
  } catch (error) {
    console.error("Instafn: Error formatting time:", error);
    return datetime;
  }
}

/**
 * Process a single time element to show exact time
 * @param {HTMLElement} timeElement - The <time> element to process
 * @param {boolean} forceReprocess - Force reprocessing even if already processed
 */
function processTimeElement(timeElement, forceReprocess = false) {
  // Skip if already processed (unless forcing reprocess)
  if (!forceReprocess && processedElements.has(timeElement)) {
    return;
  }

  const datetime = timeElement.getAttribute("datetime");
  if (!datetime) {
    return; // No datetime attribute, skip
  }

  const formattedTime = formatExactTime(datetime, currentFormat);
  
  // Update the text content
  timeElement.textContent = formattedTime;
  processedElements.add(timeElement);
}

/**
 * Process all time elements in the given root
 * @param {Node} root - Root node to search from (default: document)
 */
function processAllTimeElements(root = document) {
  const timeElements = root.querySelectorAll("time[datetime]");
  timeElements.forEach(processTimeElement);
}

/**
 * Initialize the exact time display feature
 * @param {boolean} enabled - Whether the feature is enabled
 * @param {string} format - Time format to use (default: "default")
 */
function initExactTimeDisplay(enabled = true, format = "default") {
  // Check if format changed - if so, we need to reprocess all elements
  const formatChanged = format !== currentFormat;
  
  // Update current settings
  currentEnabled = enabled;
  currentFormat = format;

  // Clean up existing observer if disabling
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (!enabled) {
    // Clear processed elements when disabled
    processedElements = new WeakSet();
    return;
  }

  // If format changed, clear processed elements and reprocess all
  if (formatChanged) {
    processedElements = new WeakSet();
    // Force reprocess all existing elements with new format
    const timeElements = document.querySelectorAll("time[datetime]");
    timeElements.forEach((el) => processTimeElement(el, true));
  } else {
    // Process existing time elements immediately (only new ones)
    processAllTimeElements();
  }

  // Set up MutationObserver to handle dynamically added time elements
  observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      // Process newly added nodes
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // If the added node is itself a time element
          if (node.tagName === "TIME" && node.hasAttribute("datetime")) {
            processTimeElement(node);
          }
          // Also check for time elements within the added node
          const timeElements = node.querySelectorAll?.("time[datetime]");
          if (timeElements) {
            timeElements.forEach(processTimeElement);
          }
        }
      });

      // Handle attribute changes (e.g., if datetime attribute is added/changed)
      if (mutation.type === "attributes" && mutation.attributeName === "datetime") {
        if (mutation.target.tagName === "TIME") {
          // Force reprocess when datetime attribute changes
          processTimeElement(mutation.target, true);
        }
      }
    });
  });

  // Observe the entire document for changes
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["datetime"],
  });
}



module.exports.formatWithTokens = formatWithTokens;
module.exports.formatExactTime = formatExactTime;
module.exports.initExactTimeDisplay = initExactTimeDisplay;
});


defineModule("features/message-logger/message-viewer.js", function (module, exports, require) {
/**
 * Message Viewer UI
 * 
 * Adds a button to view all logged messages in a modal
 */

var { createModal } = require("ui/modal.js");
var { resolveThreadDisplayName } = require("features/message-logger/thread-name.js");

const ARCHIVE_ICON_PATH =
  '<polyline points="21 8 21 21 3 21 3 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline><rect x="1" y="3" width="22" height="5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></rect><line x1="10" y1="12" x2="14" y2="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></line>';

let messageViewerButton = null;
let messageViewerModal = null;

// Timestamp (ms) of the last time the user opened the viewer. Anything deleted
// after this is considered "unread" and drives the blue dot on the icon.
const STORAGE_KEY_LAST_SEEN = 'instafn_message_log_last_seen';

function getLastSeen() {
  const value = parseInt(localStorage.getItem(STORAGE_KEY_LAST_SEEN), 10);
  return isNaN(value) ? 0 : value;
}

// Number of deleted messages newer than the last time the viewer was opened.
function getUnreadCount() {
  const store = getDeletedMessages();
  const lastSeen = getLastSeen();
  let count = 0;
  for (const msg of store.values()) {
    const ts = parseInt(msg.deletedAt || msg.timestamp, 10) || 0;
    if (ts > lastSeen) count++;
  }
  return count;
}

// Record that the user has now seen everything up to this moment.
function markMessageLogSeen() {
  try {
    localStorage.setItem(STORAGE_KEY_LAST_SEEN, String(Date.now()));
  } catch (e) {
    // Ignore storage errors — the dot just won't clear, which is harmless.
  }
}

// Show/hide a small blue dot in the top-right corner of the viewer button to
// signal unread (newly deleted) messages.
function updateUnreadDot(button) {
  if (!button) return;
  let dot = button.querySelector('[data-instafn-unread-dot="true"]');
  const hasUnread = getUnreadCount() > 0;

  if (hasUnread) {
    if (!dot) {
      button.style.position = 'relative';
      dot = document.createElement('span');
      dot.dataset.instafnUnreadDot = 'true';
      dot.style.cssText = `
        position: absolute;
        top: 3px;
        right: 3px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgb(var(--ig-outgoing-message-bubble));
        box-shadow: 0 0 0 2px rgb(var(--ig-secondary-background, 0 0 0));
        pointer-events: none;
      `;
      button.appendChild(dot);
    }
  } else if (dot) {
    dot.remove();
  }
}

// Get all deleted messages from the store
function getDeletedMessages() {
  // Access the deletedMessagesStore from the message logger
  if (window.Instafn && window.Instafn.getDeletedMessagesStore) {
    const store = window.Instafn.getDeletedMessagesStore();
    return store instanceof Map ? store : new Map();
  }
  return new Map();
}

// Get thread name map from storage
function getThreadNameMap() {
  try {
    const stored = localStorage.getItem("instafn_thread_names");
    if (stored) {
      const mapArray = JSON.parse(stored);
      const map = new Map();
      mapArray.forEach(([threadId, threadName]) => {
        map.set(String(threadId), threadName);
      });
      return map;
    }
  } catch (e) {
    console.error("[Instafn Message Viewer] Error loading thread name map:", e);
  }
  return new Map();
}

// Get sender username map from storage
function getSenderUsernameMap() {
  try {
    const stored = localStorage.getItem("instafn_sender_usernames");
    if (stored) {
      const mapArray = JSON.parse(stored);
      const map = new Map();
      mapArray.forEach(([fbid, username]) => {
        map.set(String(fbid), username);
      });
      return map;
    }
  } catch (e) {
    console.error("[Instafn Message Viewer] Error loading sender username map:", e);
  }
  return new Map();
}

// Get thread participants map from storage
function getThreadParticipantsMap() {
  try {
    const stored = localStorage.getItem("instafn_thread_participants");
    if (stored) {
      const mapArray = JSON.parse(stored);
      const map = new Map();
      mapArray.forEach(([threadId, fbids]) => {
        if (Array.isArray(fbids)) {
          map.set(String(threadId), fbids.map(String));
        }
      });
      return map;
    }
  } catch (e) {
    console.error("[Instafn Message Viewer] Error loading thread participants map:", e);
  }
  return new Map();
}

// Get thread display-name map from storage (header text captured per open thread)
function getThreadDisplayNameMap() {
  try {
    const stored = localStorage.getItem("instafn_thread_display_names");
    if (stored) {
      const mapArray = JSON.parse(stored);
      const map = new Map();
      mapArray.forEach(([threadId, name]) => {
        map.set(String(threadId), name);
      });
      return map;
    }
  } catch (e) {
    console.error("[Instafn Message Viewer] Error loading thread display-name map:", e);
  }
  return new Map();
}

// Get current user Facebook ID from storage
function getCurrentUserFbid() {
  try {
    return localStorage.getItem("instafn_current_user_fbid");
  } catch (e) {
    return null;
  }
}

// Format timestamp into a compact "Jun 9, 2026 · 12:45 AM" form
function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown';

  const ts = parseInt(timestamp);
  if (isNaN(ts)) return 'Invalid';

  const date = new Date(ts);
  const datePart = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart} · ${timePart}`;
}

// Create the message viewer modal. `unreadSince` is the "last seen" timestamp
// captured before this open, so rows for messages deleted after it get a dot.
async function createMessageViewerModal(unreadSince = 0) {
  // Remove existing modal if present
  if (messageViewerModal) {
    messageViewerModal.remove();
    messageViewerModal = null;
  }
  
  // Create modal using the abstract modal component
  const overlay = await createModal('Deleted Messages', { showTabs: false });
  messageViewerModal = overlay;
  
  const modal = overlay.querySelector('.instafn-modal');
  // Make the modal wider
  modal.classList.add('instafn-modal--wide');
  const content = overlay.querySelector('.instafn-content');
  
  // Table container
  const tableContainer = document.createElement('div');
  tableContainer.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 0;
  `;
  
  // Table
  const table = document.createElement('table');
  table.style.cssText = `
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-family-system);
    table-layout: auto;
  `;

  // Table header
  const thead = document.createElement('thead');
  thead.style.cssText = `
    position: sticky;
    top: 0;
    background: rgb(var(--ig-elevated-background));
    z-index: 10;
  `;

  const headerRow = document.createElement('tr');
  headerRow.style.cssText = `
    border-bottom: 1px solid rgba(var(--ig-primary-text), 0.08);
  `;
  const headers = ['Message', 'By', 'Thread', 'Timestamp', ''];
  headers.forEach((headerText, index) => {
    const th = document.createElement('th');
    th.textContent = headerText;
    th.style.cssText = `
      padding: 10px 16px;
      text-align: ${index === headers.length - 1 ? 'center' : 'left'};
      vertical-align: middle;
      font-weight: var(--font-weight-system-semibold);
      font-size: var(--system-12-font-size);
      color: rgb(var(--ig-secondary-text));
      white-space: nowrap;
      font-family: var(--font-family-system);
    `;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  
  // Table body
  const tbody = document.createElement('tbody');
  
  // Get all deleted messages
  const deletedMessages = getDeletedMessages();
  // Get thread name map and sender username map from storage
  const threadNameMap = getThreadNameMap();
  const senderUsernameMap = getSenderUsernameMap();
  const threadParticipantsMap = getThreadParticipantsMap();
  const threadDisplayNameMap = getThreadDisplayNameMap();
  const currentUserFbid = getCurrentUserFbid();
  
  const messageArray = Array.from(deletedMessages.entries())
    .map(([id, msg]) => ({ id, ...msg }))
    .sort((a, b) => {
      const tsA = parseInt(a.deletedAt || a.timestamp) || 0;
      const tsB = parseInt(b.deletedAt || b.timestamp) || 0;
      return tsB - tsA; // Newest first
    });
  
  if (messageArray.length === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = headers.length;
    emptyCell.textContent = 'No deleted messages yet';
    emptyCell.style.cssText = `
      padding: 40px;
      text-align: center;
      color: rgb(var(--ig-secondary-text));
      font-size: var(--system-14-font-size);
      font-family: var(--font-family-system);
    `;
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    messageArray.forEach((msg, index) => {
      const row = document.createElement('tr');
      row.style.cssText = `
        border-bottom: 1px solid rgba(var(--ig-primary-text), 0.06);
        transition: background 0.15s;
      `;
      row.onmouseover = () => {
        row.style.background = 'rgb(var(--ig-highlight-background))';
      };
      row.onmouseout = () => {
        row.style.background = 'transparent';
      };

      // Message cell
      const messageCell = document.createElement('td');
      const hasText = Boolean(msg.text);
      const messageText = msg.text || 'No text';
      messageCell.style.cssText = `
        padding: 11px 16px;
        font-size: var(--system-13-font-size);
        line-height: 1.4;
        color: ${hasText ? 'rgb(var(--ig-primary-text))' : 'rgb(var(--ig-secondary-text))'};
        font-style: ${hasText ? 'normal' : 'italic'};
        word-break: break-word;
        vertical-align: top;
        font-family: var(--font-family-system);
        font-weight: var(--font-weight-system-medium);
        min-width: 200px;
        max-width: none;
      `;

      // Lay out an optional unread dot to the left of the text.
      const messageWrap = document.createElement('div');
      messageWrap.style.cssText = 'display: flex; align-items: baseline; gap: 8px;';

      const isUnread =
        (parseInt(msg.deletedAt || msg.timestamp, 10) || 0) > unreadSince;
      if (isUnread) {
        const dot = document.createElement('span');
        dot.style.cssText = `
          flex: 0 0 auto;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgb(var(--ig-outgoing-message-bubble));
          align-self: center;
        `;
        messageWrap.appendChild(dot);
      }

      const textSpan = document.createElement('span');
      if (messageText.length > 150) {
        textSpan.textContent = messageText.substring(0, 150) + '...';
        textSpan.title = messageText;
      } else {
        textSpan.textContent = messageText;
      }
      messageWrap.appendChild(textSpan);
      messageCell.appendChild(messageWrap);
      row.appendChild(messageCell);
      
      // By cell - look up username from originalSender
      const byCell = document.createElement('td');
      const senderFbid = String(msg.originalSender || '');
      let deletedByDisplay = 'Unknown';
      
      if (senderFbid) {
        // Check if sender is current user
        if (currentUserFbid && senderFbid === currentUserFbid) {
          deletedByDisplay = 'You';
        } else {
          // Look up username from sender map
          const username = senderUsernameMap.get(senderFbid);
          if (username) {
            deletedByDisplay = username;
          } else {
            // No username found - show the sender ID
            deletedByDisplay = senderFbid;
          }
        }
      }
      
      byCell.textContent = deletedByDisplay;
      byCell.style.cssText = `
        padding: 11px 16px;
        font-size: var(--system-13-font-size);
        line-height: 1.4;
        color: rgb(var(--ig-primary-text));
        font-family: var(--font-family-system);
        vertical-align: top;
        white-space: nowrap;
        min-width: 120px;
      `;
      row.appendChild(byCell);
      
      // Thread cell - resolve the display name fresh from storage every time, so
      // names that were captured after the message was deleted are picked up. We
      // intentionally ignore msg.threadName: older logs may carry a name from the
      // buggy DOM-scraping era, and the resolver below is authoritative.
      const threadCell = document.createElement('td');
      const displayThreadName = resolveThreadDisplayName({
        threadId: msg.threadFbid || msg.threadId || msg.thread,
        senderFbid: msg.originalSender,
        participantsMap: threadParticipantsMap,
        threadNameMap,
        displayNameMap: threadDisplayNameMap,
        senderUsernameMap,
        currentUserFbid,
      });

      threadCell.textContent = displayThreadName;
      threadCell.style.cssText = `
        padding: 11px 16px;
        font-size: var(--system-13-font-size);
        line-height: 1.4;
        color: rgb(var(--ig-primary-text));
        font-family: var(--font-family-system);
        vertical-align: top;
        min-width: 150px;
      `;
      if (displayThreadName.length > 40) {
        threadCell.textContent = displayThreadName.substring(0, 40) + '...';
        threadCell.title = displayThreadName;
      }
      row.appendChild(threadCell);
      
      // Timestamp cell
      const timestampCell = document.createElement('td');
      timestampCell.textContent = formatTimestamp(msg.timestamp);
      timestampCell.style.cssText = `
        padding: 11px 16px;
        font-size: var(--system-13-font-size);
        line-height: 1.4;
        color: rgb(var(--ig-secondary-text));
        font-family: var(--font-family-system);
        vertical-align: top;
        white-space: nowrap;
        min-width: 150px;
      `;
      row.appendChild(timestampCell);

      // Delete button cell
      const deleteCell = document.createElement('td');
      deleteCell.style.cssText = `
        padding: 6px 10px;
        text-align: right;
        vertical-align: top;
        white-space: nowrap;
        width: 1%;
      `;
      const deleteButton = document.createElement('button');
      deleteButton.innerHTML = `
        <svg aria-label="Delete" fill="currentColor" height="16" role="img" viewBox="0 0 24 24" width="16">
          <title>Delete</title>
          <path d="M20.654 5.717h-3.605V4.039A2.041 2.041 0 0 0 15.01 2H8.99a2.041 2.041 0 0 0-2.039 2.039v1.678H3.347a.75.75 0 1 0 0 1.5h.806v12.744A2.041 2.041 0 0 0 6.191 22h11.618a2.041 2.041 0 0 0 2.038-2.039V7.217h.807a.75.75 0 1 0 0-1.5ZM8.451 4.039a.539.539 0 0 1 .539-.539h6.02a.539.539 0 0 1 .539.539v1.678H8.451Zm9.896 15.922a.539.539 0 0 1-.538.539H6.191a.539.539 0 0 1-.538-.539V7.217h12.694ZM9.872 17.5a.75.75 0 0 0 .75-.75V10.5a.75.75 0 0 0-1.5 0v6.25c0 .414.336.75.75.75Zm4.256 0a.75.75 0 0 0 .75-.75V10.5a.75.75 0 0 0-1.5 0v6.25c0 .414.336.75.75.75Z"></path>
        </svg>
      `;
      deleteButton.setAttribute('aria-label', 'Delete message');
      deleteButton.style.cssText = `
        background: transparent;
        color: rgb(var(--ig-secondary-text));
        border: none;
        border-radius: 50%;
        padding: 6px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        width: 28px;
        height: 28px;
      `;
      deleteButton.onmouseover = () => {
        deleteButton.style.background = 'rgba(var(--ig-primary-text), 0.1)';
        deleteButton.style.color = 'rgb(var(--ig-primary-text))';
      };
      deleteButton.onmouseout = () => {
        deleteButton.style.background = 'transparent';
        deleteButton.style.color = 'rgb(var(--ig-secondary-text))';
      };
      deleteButton.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to delete this message from the log?`)) {
          // Remove from deleted messages store
          if (window.Instafn && window.Instafn.getDeletedMessagesStore) {
            const store = window.Instafn.getDeletedMessagesStore();
            if (store instanceof Map) {
              store.delete(msg.id);
              // Save to localStorage
              if (window.Instafn && window.Instafn.saveDeletedMessages) {
                window.Instafn.saveDeletedMessages();
              }
            }
          }
          // Remove row from table
          row.remove();
          // Keep the trailing divider off whatever row is now last.
          if (tbody.lastElementChild) {
            tbody.lastElementChild.style.borderBottom = 'none';
          }
          // If no more messages, show empty state
          if (tbody.children.length === 0) {
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = headers.length;
            emptyCell.textContent = 'No deleted messages yet';
            emptyCell.style.cssText = `
              padding: 40px;
              text-align: center;
              color: rgb(var(--ig-secondary-text));
              font-size: var(--system-14-font-size);
              font-family: var(--font-family-system);
            `;
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
          }
        }
      };
      deleteCell.appendChild(deleteButton);
      row.appendChild(deleteCell);
      
      tbody.appendChild(row);
    });

    // Drop the trailing divider on the last row so it doesn't double up with
    // the modal/content edge.
    const lastRow = tbody.lastElementChild;
    if (lastRow) {
      lastRow.style.borderBottom = 'none';
    }
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  tableContainer.appendChild(table);
  
  // Assemble modal content
  content.appendChild(tableContainer);
  
  // Update close handler to clear reference
  const closeBtn = overlay.querySelector('.instafn-close');
  if (closeBtn) {
    const originalHandler = closeBtn.onclick;
    closeBtn.onclick = () => {
      if (originalHandler) originalHandler();
      messageViewerModal = null;
    };
  }
  
  return overlay;
}

// Create the message viewer button
function createMessageViewerButton() {
  // Find the microphone button (voice clip button)
  const voiceClipButton = document.querySelector('svg[aria-label="Voice Clip"]')?.closest('[role="button"]');
  if (!voiceClipButton) return null;
  
  // Check if button already exists
  if (document.querySelector('[data-instafn-message-viewer-btn="true"]')) {
    return document.querySelector('[data-instafn-message-viewer-btn="true"]');
  }
  
  // Find the parent container
  const parent = voiceClipButton.parentElement;
  if (!parent) return null;
  
  // Clone the voice clip button structure for styling
  const button = voiceClipButton.cloneNode(true);
  button.dataset.instafnMessageViewerBtn = 'true';
  button.setAttribute('aria-label', 'View logged messages');
  button.title = 'View logged messages';
  button.tabIndex = 0;
  
  // Update the SVG to use archive icon
  const svg = button.querySelector('svg');
  if (svg) {
    svg.setAttribute('aria-label', 'View logged messages');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('height', '24');
    svg.setAttribute('width', '24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = ARCHIVE_ICON_PATH;
    svg.style.color = '#f5f5f5';
  }
  
  // Add click handler
  button.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture what was unread BEFORE marking seen, so the modal can still flag
    // those rows. Opening then marks the log as seen and clears the icon dot.
    const unreadSince = getLastSeen();
    markMessageLogSeen();
    updateUnreadDot(button);

    // Remove existing modal if present (to refresh data)
    if (messageViewerModal) {
      messageViewerModal.remove();
      messageViewerModal = null;
    }

    // Create and show new modal with fresh data
    messageViewerModal = await createMessageViewerModal(unreadSince);
  };

  // Insert before the voice clip button
  parent.insertBefore(button, voiceClipButton);

  // Reflect any unread messages as soon as the button appears.
  updateUnreadDot(button);

  return button;
}

// Setup message viewer button
function setupMessageViewer() {
  const ensureButtonExists = () => {
    // Only show in DM chat context
    const isDMContext = window.location.pathname.includes('/direct/t/');

    // When the composer has text, Instagram swaps the mic/action buttons for a
    // Send button. The logger button must not show in that state or it breaks
    // the composer layout (it stacks above Send).
    const sendButton = document.querySelector('[aria-label="Send"][role="button"], svg[aria-label="Send"]');
    const voiceClipButton = document.querySelector('svg[aria-label="Voice Clip"]')?.closest('[role="button"]');

    if (!isDMContext || sendButton || !voiceClipButton) {
      if (messageViewerButton) {
        messageViewerButton.remove();
        messageViewerButton = null;
      }
      return;
    }

    // Try to create button if it doesn't exist
    if (!messageViewerButton || !document.contains(messageViewerButton)) {
      messageViewerButton = createMessageViewerButton();
    } else {
      // Button already present — keep its unread dot in sync.
      updateUnreadDot(messageViewerButton);
    }
  };

  // Update the dot the moment a new message is deleted, even if the modal is closed.
  window.addEventListener('instafn-new-deleted-message', () => {
    if (messageViewerButton && document.contains(messageViewerButton)) {
      updateUnreadDot(messageViewerButton);
    }
  });

  // Initial setup
  ensureButtonExists();
  
  // Watch for DOM changes
  const observer = new MutationObserver(() => {
    ensureButtonExists();
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Also check on navigation
  let lastHref = window.location.href;
  const checkNavigation = () => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      setTimeout(ensureButtonExists, 100);
    }
  };
  
  setInterval(checkNavigation, 500);
  
  // Check on popstate
  window.addEventListener('popstate', () => {
    setTimeout(ensureButtonExists, 100);
  });
}



module.exports.setupMessageViewer = setupMessageViewer;
});


defineModule("features/message-logger/index.js", function (module, exports, require) {
/**
 * Message Logger Feature
 *
 * Tracks messages sent in DMs and logs when messages are deleted,
 * including what message was deleted.
 */

var { resolveThreadDisplayName } = require("features/message-logger/thread-name.js");

// Store messages by message_id
const messageStore = new Map();

// Store deleted messages with full info
const deletedMessagesStore = new Map();

// Store mapping of sender_fbid to username (from GraphQL data)
const senderUsernameMap = new Map();

// Store current user's Facebook ID
let currentUserFbid = null;

// Store mapping of thread_fbid to thread name (for group chats)
const threadNameMap = new Map();

// Store mapping of thread_fbid to participant fbids (interop fbids, all threads).
// This is how we name DMs ("the participant who isn't you") without scraping the
// on-screen header, which was attributing the wrong thread to most messages.
const threadParticipantsMap = new Map();

// Store mapping of thread_fbid to the conversation header text, captured ONLY
// while that exact thread is open (URL /direct/t/<id>/ === the delta thread_fbid).
// Pairing the URL id with the visible header is reliable; this is what lets us
// show a group's name/member list even when the inbox GraphQL never loads.
const threadDisplayNameMap = new Map();

// LocalStorage keys
const STORAGE_KEY_MESSAGE_STORE = "instafn_message_store";
const STORAGE_KEY_DELETED_MESSAGES = "instafn_deleted_messages";
const STORAGE_KEY_SENDER_USERNAMES = "instafn_sender_usernames";
const STORAGE_KEY_CURRENT_USER_FBID = "instafn_current_user_fbid";
const STORAGE_KEY_THREAD_NAMES = "instafn_thread_names";
const STORAGE_KEY_THREAD_PARTICIPANTS = "instafn_thread_participants";
const STORAGE_KEY_THREAD_DISPLAY_NAMES = "instafn_thread_display_names";
const STORAGE_KEY_THREAD_NAMES_MIGRATED = "instafn_thread_names_migrated_v1";

// Configuration
const MAX_STORE_SIZE = 5000; // Maximum messages to store
const MESSAGE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Cleanup old messages periodically
function cleanupOldMessages() {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, message] of messageStore.entries()) {
    // Remove messages older than TTL
    if (message.timestamp && now - parseInt(message.timestamp) > MESSAGE_TTL) {
      messageStore.delete(id);
      cleaned++;
    }
  }

  // If still too large, remove oldest messages
  if (messageStore.size > MAX_STORE_SIZE) {
    const entries = Array.from(messageStore.entries()).sort(
      (a, b) =>
        (parseInt(a[1].timestamp) || 0) - (parseInt(b[1].timestamp) || 0)
    );

    const toRemove = messageStore.size - MAX_STORE_SIZE;
    for (let i = 0; i < toRemove; i++) {
      messageStore.delete(entries[i][0]);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldMessages, 5 * 60 * 1000);

// Parse binary WebSocket message
function parseWebSocketMessage(data, dataType) {
  try {
    let bytes = null;
    let str = "";

    // Handle array (converted from ArrayBuffer/Uint8Array)
    if (Array.isArray(data)) {
      bytes = new Uint8Array(data);
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (
          (byte >= 32 && byte <= 126) ||
          byte === 9 ||
          byte === 10 ||
          byte === 13
        ) {
          str += String.fromCharCode(byte);
        } else if (byte === 0) {
          continue;
        }
      }
    }
    // Handle ArrayBuffer
    else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (
          (byte >= 32 && byte <= 126) ||
          byte === 9 ||
          byte === 10 ||
          byte === 13
        ) {
          str += String.fromCharCode(byte);
        } else if (byte === 0) {
          continue;
        }
      }
    }
    // Handle Uint8Array
    else if (data instanceof Uint8Array) {
      bytes = data;
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (
          (byte >= 32 && byte <= 126) ||
          byte === 9 ||
          byte === 10 ||
          byte === 13
        ) {
          str += String.fromCharCode(byte);
        } else if (byte === 0) {
          continue;
        }
      }
    }
    // Handle string data
    else if (typeof data === "string") {
      str = data;
    }

    if (!str) return null;

    // Look for /ig_message_sync path and extract JSON after it
    const syncIndex = str.indexOf("/ig_message_sync");

    if (syncIndex !== -1) {
      const afterSync = str.substring(syncIndex + "/ig_message_sync".length);
      const jsonStart = afterSync.indexOf("[");

      if (jsonStart !== -1) {
        let depth = 0;
        let jsonEnd = -1;
        for (let i = jsonStart; i < afterSync.length; i++) {
          if (afterSync[i] === "[") depth++;
          if (afterSync[i] === "]") {
            depth--;
            if (depth === 0) {
              jsonEnd = i + 1;
              break;
            }
          }
        }

        if (jsonEnd !== -1) {
          const jsonStr = afterSync.substring(jsonStart, jsonEnd);
          try {
            return JSON.parse(jsonStr);
          } catch (e) {
            // Try to find any JSON array in the string
            const jsonMatch = str.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              try {
                return JSON.parse(jsonMatch[0]);
              } catch (e2) {
                try {
                  return JSON.parse(str);
                } catch (e3) {
                  // Failed to parse
                }
              }
            }
          }
        }
      }
    }

    // Fallback: try to find any JSON array in the string
    const jsonMatch = str.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        try {
          return JSON.parse(str);
        } catch (e2) {
          // Failed
        }
      }
    }

    // Last resort: try parsing the whole string as JSON
    try {
      return JSON.parse(str);
    } catch (e) {
      // Not JSON
    }
  } catch (error) {
    // Silently fail
  }

  return null;
}

// Process parsed message data
function processMessage(parsedData, url) {
  if (!parsedData || !Array.isArray(parsedData)) return;

  try {
    parsedData.forEach((item) => {
      if (!item.data?.slide_delta_processor) return;

      item.data.slide_delta_processor.forEach((delta) => {
        // DIAGNOSTIC: with window.__instafnSocketDebug on, log every delta type
        // we walk. If an unsend produces a delta whose __typename is NOT
        // "SlideUQPPDeleteMessage" (e.g. a renamed delete type), this surfaces it.
        if (window.__instafnSocketDebug) {
          console.log(
            "[Instafn Message Logger] delta __typename:",
            delta.__typename
          );
          if (
            delta.__typename !== "SlideUQPPDeleteMessage" &&
            /delete|unsend|revoke|remove/i.test(delta.__typename || "")
          ) {
            console.log(
              "[Instafn Message Logger] ⚠️ delete-like delta NOT matched by our check:",
              delta.__typename,
              delta
            );
          }
        }

        // Handle new messages
        if (delta.__typename === "SlideUQPPNewMessage" && delta.message) {
          const message = delta.message;
          const messageId = message.id;

          if (messageId) {
            const text = message.text_body || message.igd_snippet || "";

            // Cleanup if store is getting too large
            if (messageStore.size >= MAX_STORE_SIZE) {
              cleanupOldMessages();
            }

            // Get thread_fbid for this message (this is what deletion deltas use).
            // Do NOT fall back to offline_threading_id — that's a per-message id,
            // not a thread id, and using it corrupts the thread mapping.
            const messageThreadFbid = message.thread_fbid;

            // Thread names/participants come from the GraphQL inbox (see
            // processGraphQLMessages), never from the on-screen header — the
            // header reflects whatever conversation is open, not the thread this
            // WebSocket event belongs to.

            // Store the message with its content (store as much info as possible)
            messageStore.set(messageId, {
              id: messageId,
              text: text,
              timestamp: message.timestamp_ms,
              sender: message.sender_fbid,
              thread: messageThreadFbid,
              contentType: message.content_type,
              offlineThreadingId: message.offline_threading_id,
              threadFbid: message.thread_fbid,
              source: "websocket",
              storedAt: Date.now(),
              // Store full message object for reference
              raw: message,
            });
            // Persist so an unsend after a reload can still be matched.
            scheduleSaveMessageStore();

            // Only log if there's actual text content
            if (text) {
              console.log(`💬 Message: "${text}"`);
            }
          }
        }

        // Handle deleted messages
        if (delta.__typename === "SlideUQPPDeleteMessage") {
          const messageId = delta.message_id;
          const threadFbid = delta.thread_fbid;

          if (messageId) {
            const deletedMessage = messageStore.get(messageId);

            if (deletedMessage) {
              // Determine who deleted the message
              // If the message sender matches current user, current user deleted it
              // Otherwise, someone else deleted it
              let deletedByUsername = "Unknown";

              // Get current user info to determine who deleted the message
              // The sender_fbid tells us who SENT the message. In Instagram, you can only delete your own messages.
              // So: if the sender is you → you deleted it, if sender is other person → they deleted it
              const getDeletedBy = async () => {
                try {
                  const senderFbid = String(deletedMessage.sender || "");

                  // First, check if sender is the current user by comparing Facebook IDs
                  // This works for both 1-on-1 DMs and group chats
                  if (currentUserFbid && senderFbid === currentUserFbid) {
                    // It's the current user - try to get username, otherwise return "You"
                    let currentUsername = null;
                    if (window.Instafn && window.Instafn.getCurrentUser) {
                      try {
                        const currentUser = await window.Instafn.getCurrentUser();
                        if (currentUser) {
                          currentUsername = currentUser.username;
                        }
                      } catch (e) {
                        // Ignore
                      }
                    }
                    return currentUsername || "You";
                  }

                  // Not the current user - try to get their username
                  const mappedUsername = senderUsernameMap.get(senderFbid);
                  if (mappedUsername) {
                    return mappedUsername;
                  }

                  // No username found - return the sender Facebook ID
                  return senderFbid || "Unknown";
                } catch (e) {
                  // Fallback: return sender ID if available
                  const senderFbid = String(deletedMessage.sender || "");
                  return senderFbid || "Unknown";
                }
              };

              // Resolve the thread's display name from data we actually trust:
              // participant fbids (for DMs) and real group names (for groups),
              // both captured from the GraphQL inbox. The delta's thread_fbid is
              // the lookup key.
              const threadId =
                threadFbid ||
                deletedMessage.threadFbid ||
                deletedMessage.thread;

              const threadName = resolveThreadDisplayName({
                threadId,
                senderFbid: deletedMessage.sender,
                participantsMap: threadParticipantsMap,
                threadNameMap,
                displayNameMap: threadDisplayNameMap,
                senderUsernameMap,
                currentUserFbid,
              });

              console.log(
                `[Instafn Message Logger] 📌 Resolved thread name: "${threadName}" for threadId: ${threadId}`
              );

              // Store immediately - only store originalSender, not deletedBy
              // deletedBy will be computed on-the-fly when displaying from originalSender
              const deletedMsg = {
                id: messageId,
                text: deletedMessage.text || "(no text)",
                timestamp: deletedMessage.timestamp,
                deletedAt: Date.now(),
                threadName: threadName,
                threadId:
                  threadFbid ||
                  deletedMessage.threadFbid ||
                  deletedMessage.thread,
                threadFbid:
                  threadFbid ||
                  deletedMessage.threadFbid ||
                  deletedMessage.thread,
                originalSender: deletedMessage.sender,
              };
              deletedMessagesStore.set(messageId, deletedMsg);

              // Save immediately after storing
              saveDeletedMessages();

              // Tell the viewer a new entry landed so it can show its unread dot
              // without waiting for the modal to be reopened.
              window.dispatchEvent(new CustomEvent("instafn-new-deleted-message"));

              if (deletedMessage.text) {
                console.log(` Message deleted: "${deletedMessage.text}"`);
              } else {
                console.log(` Message deleted (ID: ${messageId})`);
              }

              // Remove from active message store
              messageStore.delete(messageId);
              scheduleSaveMessageStore();
            } else {
              console.log(
                ` Message deleted (ID: ${messageId}) - message not found in store`
              );
            }
          }
        }
      });
    });
  } catch (error) {
    // Silently fail
  }
}

// Hook a specific WebSocket instance
function hookWebSocketInstance(ws, url) {
  if (!ws || !url) return;

  console.log("[Instafn Message Logger] Hooking WebSocket instance:", url);
  console.log("[Instafn Message Logger] WebSocket readyState:", ws.readyState);

  // Intercept incoming messages via addEventListener
  const originalAddEventListener = ws.addEventListener.bind(ws);
  ws.addEventListener = function(type, listener, options) {
    if (type === "message") {
      console.log(
        "[Instafn Message Logger] Intercepting addEventListener for message"
      );
      return originalAddEventListener(
        type,
        (event) => {
          console.log(
            "[Instafn Message Logger] WebSocket message event received via addEventListener:",
            {
              type: event.type,
              dataType: event.data?.constructor?.name,
              url: url,
            }
          );

          // Call original listener
          if (listener) {
            if (typeof listener === "function") {
              listener(event);
            } else if (listener && typeof listener.handleEvent === "function") {
              listener.handleEvent(event);
            }
          }

          // Process the message
          const parsed = parseWebSocketMessage(event.data);
          if (parsed) {
            processMessage(parsed, url);
          } else {
            console.log(
              "[Instafn Message Logger] Could not parse message, skipping processing"
            );
          }
        },
        options
      );
    }
    return originalAddEventListener(type, listener, options);
  };

  // Intercept onmessage property
  let originalOnMessage = ws.onmessage;
  Object.defineProperty(ws, "onmessage", {
    get() {
      return this._onmessage || originalOnMessage;
    },
    set(handler) {
      this._onmessage = handler;
      originalOnMessage = handler;

      if (handler) {
        // Wrap the handler
        const wrappedHandler = (event) => {
          console.log(
            "[Instafn Message Logger] WebSocket onmessage handler called"
          );

          if (handler) handler.call(ws, event);

          // Process the message
          const parsed = parseWebSocketMessage(event.data);
          if (parsed) {
            processMessage(parsed, url);
          } else {
            console.log(
              "[Instafn Message Logger] Could not parse message from onmessage handler"
            );
          }
        };

        // Set up the wrapped handler
        originalAddEventListener("message", wrappedHandler);
      }
    },
    configurable: true,
  });

  // If WebSocket is already open, also hook existing message listeners
  if (
    ws.readyState === WebSocket.OPEN ||
    ws.readyState === WebSocket.CONNECTING
  ) {
    console.log(
      "[Instafn Message Logger] WebSocket is already open/connecting, setting up direct listener"
    );
    originalAddEventListener("message", (event) => {
      console.log(
        "[Instafn Message Logger] Direct message listener triggered:",
        {
          type: event.type,
          dataType: event.data?.constructor?.name,
          url: url,
        }
      );

      const parsed = parseWebSocketMessage(event.data);
      if (parsed) {
        processMessage(parsed, url);
      }
    });
  }
}

// Hook into WebSocket connections
function hookWebSocket() {
  console.log("[Instafn Message Logger] Setting up WebSocket hook...");

  const originalWebSocket = window.WebSocket;

  if (!originalWebSocket) {
    console.log("[Instafn Message Logger] WebSocket constructor not available");
    return;
  }

  window.WebSocket = function(...args) {
    const url = args[0];
    console.log(
      "[Instafn Message Logger] WebSocket constructor called with URL:",
      url
    );

    const ws = new originalWebSocket(...args);

    // Only hook into Instagram chat WebSocket
    if (url && url.includes("edge-chat.instagram.com")) {
      console.log(
        "[Instafn Message Logger]  Instagram chat WebSocket detected:",
        url
      );

      // Hook the instance
      hookWebSocketInstance(ws, url);
    } else {
      console.log(
        "[Instafn Message Logger] Not an Instagram chat WebSocket:",
        url
      );
    }

    return ws;
  };

  // Copy static properties
  Object.setPrototypeOf(window.WebSocket, originalWebSocket);
  Object.defineProperty(window.WebSocket, "prototype", {
    value: originalWebSocket.prototype,
    writable: false,
  });

  // Copy static constants
  Object.defineProperty(window.WebSocket, "CONNECTING", {
    value: originalWebSocket.CONNECTING,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "OPEN", {
    value: originalWebSocket.OPEN,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "CLOSING", {
    value: originalWebSocket.CLOSING,
    writable: false,
  });
  Object.defineProperty(window.WebSocket, "CLOSED", {
    value: originalWebSocket.CLOSED,
    writable: false,
  });

  console.log("[Instafn Message Logger] WebSocket hook installed");

  // Also hook at the prototype level as a backup - this catches ALL WebSocket messages
  const originalAddEventListener = WebSocket.prototype.addEventListener;
  const hookedWebSockets = new WeakSet();

  WebSocket.prototype.addEventListener = function(type, listener, options) {
    const result = originalAddEventListener.call(this, type, listener, options);

    // Check if this is an Instagram chat WebSocket
    const url = this.url;
    if (url && url.includes("edge-chat.instagram.com")) {
      // Only hook once per WebSocket instance
      if (!hookedWebSockets.has(this)) {
        hookedWebSockets.add(this);
        console.log(
          "[Instafn Message Logger]  Prototype-level hook: Instagram chat WebSocket detected:",
          url
        );
        console.log(
          "[Instafn Message Logger] WebSocket readyState:",
          this.readyState
        );

        // Add our own listener that will catch all messages
        originalAddEventListener.call(this, "message", (event) => {
          console.log(
            "[Instafn Message Logger] 🔵 Prototype-level message received from:",
            url,
            {
              dataType: event.data?.constructor?.name,
              dataLength: event.data?.length,
            }
          );

          const parsed = parseWebSocketMessage(event.data);
          if (parsed) {
            processMessage(parsed, url);
          } else {
            console.log(
              "[Instafn Message Logger] Could not parse message from prototype hook"
            );
          }
        });

        // Also hook when WebSocket opens if it's not already open
        if (this.readyState === WebSocket.CONNECTING) {
          originalAddEventListener.call(this, "open", () => {
            console.log("[Instafn Message Logger] WebSocket opened:", url);
          });
        }
      }
    }

    return result;
  };

  // Also hook the onmessage setter at prototype level
  const originalOnMessageDescriptor = Object.getOwnPropertyDescriptor(
    WebSocket.prototype,
    "onmessage"
  );
  if (originalOnMessageDescriptor) {
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      get: originalOnMessageDescriptor.get,
      set: function(handler) {
        // Call original setter
        if (originalOnMessageDescriptor.set) {
          originalOnMessageDescriptor.set.call(this, handler);
        }

        // If this is an Instagram chat WebSocket, also add our listener
        const url = this.url;
        if (
          url &&
          url.includes("edge-chat.instagram.com") &&
          !hookedWebSockets.has(this)
        ) {
          hookedWebSockets.add(this);
          console.log(
            "[Instafn Message Logger]  Prototype-level onmessage hook: Instagram chat WebSocket detected:",
            url
          );

          originalAddEventListener.call(this, "message", (event) => {
            console.log(
              "[Instafn Message Logger] 🔵 Prototype-level onmessage received from:",
              url
            );
            const parsed = parseWebSocketMessage(event.data);
            if (parsed) {
              processMessage(parsed, url);
            }
          });
        }
      },
      configurable: true,
    });
  }

  console.log(
    "[Instafn Message Logger] Prototype-level hook installed (will catch all WebSocket messages)"
  );
}

// Find and hook existing WebSocket connections
function findAndHookExistingWebSockets() {
  console.log(
    "[Instafn Message Logger] Searching for existing WebSocket connections..."
  );

  let foundCount = 0;

  // Method 1: Look for WebSocket in window properties
  for (const key in window) {
    try {
      const value = window[key];
      if (value instanceof WebSocket) {
        const url = value.url || "unknown";
        console.log(
          "[Instafn Message Logger] Found existing WebSocket in window:",
          key,
          url
        );
        if (url.includes("edge-chat.instagram.com")) {
          console.log(
            "[Instafn Message Logger]  Found Instagram chat WebSocket! Hooking..."
          );
          hookWebSocketInstance(value, url);
          foundCount++;
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }

  // Method 2: Try to find WebSocket in React/Instagram's internal state
  // Instagram might store the WebSocket in a closure or internal variable
  // We can try to access it through various common patterns

  // Method 3: Hook all existing WebSocket instances by checking their readyState
  // This is a bit of a hack - we'll try to access WebSocket instances through
  // the prototype or by monitoring message events globally

  // Method 4: Try to intercept at a lower level - hook the EventTarget prototype
  // This might catch messages even if we can't find the WebSocket instance

  if (foundCount === 0) {
    console.log(
      "[Instafn Message Logger] No Instagram chat WebSockets found in window properties"
    );
    console.log(
      "[Instafn Message Logger] WebSocket might be stored in a closure or created in a different context"
    );
  } else {
    console.log(
      `[Instafn Message Logger] Found and hooked ${foundCount} Instagram chat WebSocket(s)`
    );
  }

  console.log(
    "[Instafn Message Logger] Finished searching for existing WebSockets"
  );
  return foundCount;
}

// Alternative: Use wsHook if available
function setupWsHook() {
  if (typeof window.wsHook !== "undefined") {
    console.log(
      "[Instafn Message Logger] Setting up wsHook for message logging"
    );

    // Preserve existing after hook if it exists
    const existingAfter = window.wsHook.after;

    // Intercept incoming messages
    window.wsHook.after = function(event, url, wsObject) {
      console.log("[Instafn Message Logger] wsHook.after called:", {
        url: url,
        hasEvent: !!event,
        hasData: !!(event && event.data),
        eventType: event?.type,
      });

      // Call existing hook first if it exists
      if (existingAfter) {
        event = existingAfter.call(this, event, url, wsObject);
      }

      // Only process Instagram chat WebSocket
      if (url && url.includes("edge-chat.instagram.com")) {
        console.log(
          "[Instafn Message Logger] Processing Instagram chat WebSocket message"
        );
        if (event && event.data) {
          const parsed = parseWebSocketMessage(event.data);
          if (parsed) {
            processMessage(parsed, url);
          } else {
            console.log(
              "[Instafn Message Logger] Could not parse message from wsHook"
            );
          }
        } else {
          console.log(
            "[Instafn Message Logger] No event or event.data in wsHook"
          );
        }
      } else {
        console.log(
          "[Instafn Message Logger] Not an Instagram chat WebSocket:",
          url
        );
      }
      return event;
    };

    return true;
  }
  return false;
}

// Process GraphQL messages from initial DM load
function processGraphQLMessages(data) {
  let storedCount = 0;

  try {
    console.log("[Instafn Message Logger]  Processing GraphQL data...");
    console.log("[Instafn Message Logger] 📦 Data structure:", {
      hasData: !!data?.data,
      hasGetSlideMailbox: !!data?.data?.get_slide_mailbox_for_iris_subscription,
    });

    const mailbox = data?.data?.get_slide_mailbox_for_iris_subscription;
    if (!mailbox) {
      console.log("[Instafn Message Logger]  No mailbox found in data");
      return 0;
    }

    const threads = mailbox.threads_by_folder?.edges || [];
    console.log(`[Instafn Message Logger] 📬 Found ${threads.length} threads`);

    threads.forEach((threadEdge, threadIdx) => {
      const thread = threadEdge?.node?.as_ig_direct_thread;
      if (!thread) {
        console.log(
          `[Instafn Message Logger]  Thread ${threadIdx} has no as_ig_direct_thread`
        );
        return;
      }

      // Extract usernames from thread participants and store mapping.
      // Also collect the participant fbids so we can name DMs reliably later.
      const participantFbids = [];
      if (thread.users && Array.isArray(thread.users)) {
        thread.users.forEach((user) => {
          const fbid = user.interop_messaging_user_fbid;
          const username = user.username;
          if (fbid) participantFbids.push(String(fbid));
          if (fbid && username) {
            senderUsernameMap.set(String(fbid), username);
            console.log(
              `[Instafn Message Logger]  Mapped sender ${fbid} → ${username}`
            );
          }
        });
        // Save the map after processing thread users
        saveSenderUsernameMap();
      }

      // Store current user's Facebook ID from viewer info
      if (thread.viewer) {
        const viewerFbid = thread.viewer.interop_messaging_user_fbid;
        if (viewerFbid) {
          currentUserFbid = String(viewerFbid);
          localStorage.setItem(STORAGE_KEY_CURRENT_USER_FBID, currentUserFbid);
          console.log(
            `[Instafn Message Logger]  Stored current user FBID: ${currentUserFbid}`
          );
          // Include the viewer so the participant count reflects everyone.
          if (!participantFbids.includes(String(viewerFbid))) {
            participantFbids.push(String(viewerFbid));
          }
        }
      }

      // Get thread IDs - we need to store the thread name with multiple keys to ensure we can find it
      const threadId = thread.thread_id || thread.id;
      // Also check thread_key - this might be the thread_fbid used in deletion deltas
      const threadKey = thread.thread_key;

      // A thread is a group when it's not a 1:1. Instagram tags real DMs with
      // thread_subtype "IG_ONLY_ONE_TO_ONE", which is the strongest signal; when
      // it's missing we fall back to the participant count. We count
      // participantFbids (which already includes the viewer, added above) rather
      // than thread.users, because thread.users excludes the viewer and would make
      // a 3-person group look like a 2-person DM. Getting this right matters
      // because storing a name in threadNameMap is itself the "this is a group"
      // signal the resolver uses — naming a DM here would misclassify it.
      const isOneToOne = thread.thread_subtype === "IG_ONLY_ONE_TO_ONE";
      const isGroupChat = thread.thread_subtype
        ? !isOneToOne
        : participantFbids.length > 2;

      // The group's display title. Instagram's inbox field is `thread_title`
      // (the old code looked for thread_name/title, which don't exist, so every
      // group came through unnamed and fell back to the member list). Only trust
      // it for groups — a DM's thread_title is just the partner's name and must
      // go through the participant-based path, not the group-name map.
      const threadName = isGroupChat
        ? thread.thread_title || thread.thread_name || thread.title || null
        : null;

      // DIAGNOSTIC: for groups that still have no title, dump every field of the
      // thread object so we can find which one holds the custom group name.
      if (isGroupChat && !threadName) {
        const dump = {};
        for (const k of Object.keys(thread)) {
          const v = thread[k];
          // Only scalar fields — skip the big arrays/objects (users, messages).
          if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            dump[k] = v;
          } else {
            dump[k] = `<${Array.isArray(v) ? "array[" + v.length + "]" : typeof v}>`;
          }
        }
        console.log(
          "[Instafn Message Logger][thread-fields] unnamed group " + (thread.thread_id || thread.id),
          dump
        );
      }

      // Store participant fbids under every id form a deletion delta might use,
      // so we can later name the thread from its participants regardless of which
      // id format the delta carries.
      if (participantFbids.length > 0) {
        const participantKeys = [
          threadId,
          thread.id,
          threadKey,
          thread.thread_fbid,
        ];
        let storedParticipants = false;
        for (const key of participantKeys) {
          if (key) {
            threadParticipantsMap.set(String(key), participantFbids);
            storedParticipants = true;
          }
        }
        if (storedParticipants) {
          saveThreadParticipantsMap();
        }
      }

      // Store thread name using multiple keys:
      // 1. thread.thread_id (long GraphQL ID)
      // 2. thread.thread_key (might be the thread_fbid used in deletion deltas)
      // This ensures we can find it regardless of which ID format is used
      if (threadName) {
        if (threadId) {
          threadNameMap.set(String(threadId), threadName);
          console.log(
            `[Instafn Message Logger]  Mapped thread ID ${threadId} → "${threadName}"`
          );
        }
        if (threadKey && String(threadKey) !== String(threadId)) {
          threadNameMap.set(String(threadKey), threadName);
          console.log(
            `[Instafn Message Logger]  Mapped thread key ${threadKey} → "${threadName}"`
          );
        }
        // Save immediately to localStorage
        localStorage.setItem(
          STORAGE_KEY_THREAD_NAMES,
          JSON.stringify(Array.from(threadNameMap.entries()))
        );
        console.log(
          `[Instafn Message Logger] 💾 Saved thread name "${threadName}" to storage (keys: ${threadId}${
            threadKey && String(threadKey) !== String(threadId)
              ? `, ${threadKey}`
              : ""
          })`
        );
      } else if (isGroupChat) {
        // Store empty string to mark this as a group chat without a name
        if (threadId) {
          threadNameMap.set(String(threadId), "");
          console.log(
            `[Instafn Message Logger]  Marked thread ID ${threadId} as group chat (no name)`
          );
        }
        if (threadKey && String(threadKey) !== String(threadId)) {
          threadNameMap.set(String(threadKey), "");
          console.log(
            `[Instafn Message Logger]  Marked thread key ${threadKey} as group chat (no name)`
          );
        }
        // Save immediately to localStorage
        localStorage.setItem(
          STORAGE_KEY_THREAD_NAMES,
          JSON.stringify(Array.from(threadNameMap.entries()))
        );
        console.log(
          `[Instafn Message Logger] 💾 Saved group chat marker to storage (keys: ${threadId}${
            threadKey && String(threadKey) !== String(threadId)
              ? `, ${threadKey}`
              : ""
          })`
        );
      }
      // If it's not a group chat (DM), we don't store it - so absence from map = DM

      const messages = thread.slide_messages?.edges || [];
      console.log(
        `[Instafn Message Logger] 💬 Thread ${threadIdx} has ${messages.length} messages`
      );

      messages.forEach((messageEdge, msgIdx) => {
        const message = messageEdge?.node;
        if (!message) {
          console.log(
            `[Instafn Message Logger]  Message ${msgIdx} in thread ${threadIdx} has no node`
          );
          return;
        }

        if (message.__typename !== "SlideMessage") {
          console.log(
            `[Instafn Message Logger]  Message ${msgIdx} type is ${message.__typename}, not SlideMessage`
          );
          return;
        }

        const messageId = message.id;
        if (!messageId) {
          console.log(
            `[Instafn Message Logger]  Message ${msgIdx} has no ID`
          );
          return;
        }

        // Get thread_fbid from the message - store thread name with this key too
        // Check multiple possible fields that might match deletion delta thread_fbid
        const messageThreadFbid =
          message.thread_fbid ||
          message.thread_id ||
          thread.thread_key || // thread_key might be the thread_fbid used in deletion deltas
          thread.thread_id ||
          thread.id;

        // Bind the per-message thread_fbid (the id WebSocket deltas use) to this
        // thread's participants, so DM naming works for the exact delta key.
        if (participantFbids.length > 0 && message.thread_fbid) {
          threadParticipantsMap.set(
            String(message.thread_fbid),
            participantFbids
          );
        }

        // Store thread name using multiple keys for redundancy
        // The key insight: deletion deltas use thread_fbid which might be thread.thread_key
        // Store with ALL possible ID variations to ensure we can find it
        let savedThreadName = false;
        if (threadName) {
          // Store with thread.thread_key (this is likely what deletion deltas use)
          if (threadKey) {
            threadNameMap.set(String(threadKey), threadName);
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Mapped thread key ${threadKey} → "${threadName}"`
            );
          }
          // Store with message's thread_fbid
          if (
            messageThreadFbid &&
            String(messageThreadFbid) !== String(threadKey || "")
          ) {
            threadNameMap.set(String(messageThreadFbid), threadName);
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Mapped message thread_fbid ${messageThreadFbid} → "${threadName}"`
            );
          }
          // Also store with thread ID if different
          if (
            threadId &&
            String(threadId) !== String(messageThreadFbid || "") &&
            String(threadId) !== String(threadKey || "")
          ) {
            threadNameMap.set(String(threadId), threadName);
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Also mapped thread ID ${threadId} → "${threadName}"`
            );
          }
          // Store with message.thread_id if it exists and is different
          if (
            message.thread_id &&
            String(message.thread_id) !== String(messageThreadFbid || "") &&
            String(message.thread_id) !== String(threadId || "") &&
            String(message.thread_id) !== String(threadKey || "")
          ) {
            threadNameMap.set(String(message.thread_id), threadName);
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Also mapped message.thread_id ${message.thread_id} → "${threadName}"`
            );
          }
          // Store with message.thread_fbid if it exists and is different
          if (
            message.thread_fbid &&
            String(message.thread_fbid) !== String(messageThreadFbid || "") &&
            String(message.thread_fbid) !== String(threadId || "") &&
            String(message.thread_fbid) !== String(threadKey || "") &&
            String(message.thread_fbid) !== String(message.thread_id || "")
          ) {
            threadNameMap.set(String(message.thread_fbid), threadName);
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Also mapped message.thread_fbid ${message.thread_fbid} → "${threadName}"`
            );
          }
        } else if (isGroupChat) {
          // Store empty string to mark as group chat without name
          if (threadKey) {
            threadNameMap.set(String(threadKey), "");
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Marked thread key ${threadKey} as group chat (no name)`
            );
          }
          if (
            messageThreadFbid &&
            String(messageThreadFbid) !== String(threadKey || "")
          ) {
            threadNameMap.set(String(messageThreadFbid), "");
            savedThreadName = true;
            console.log(
              `[Instafn Message Logger]  Marked message thread_fbid ${messageThreadFbid} as group chat (no name)`
            );
          }
          if (
            threadId &&
            String(threadId) !== String(messageThreadFbid || "") &&
            String(threadId) !== String(threadKey || "")
          ) {
            threadNameMap.set(String(threadId), "");
            savedThreadName = true;
          }
        }

        // Save to localStorage immediately if we stored a thread name
        if (savedThreadName) {
          localStorage.setItem(
            STORAGE_KEY_THREAD_NAMES,
            JSON.stringify(Array.from(threadNameMap.entries()))
          );
        }

        // Extract text from igd_snippet
        // Format can be "username: message" or "You: message" or just "message"
        let text = message.igd_snippet || "";
        const originalText = text;

        // Clean up the snippet format (remove username prefix if present)
        const colonIndex = text.indexOf(": ");
        if (colonIndex > 0) {
          text = text.substring(colonIndex + 2);
        }

        // Skip non-text messages (attachments, reactions, etc.)
        if (
          !text ||
          text.includes("sent an attachment") ||
          text.includes("sent a photo") ||
          text.includes("sent a voice message") ||
          text.includes("Liked a message") ||
          text.includes("Reacted") ||
          text.includes("started a video chat") ||
          text.includes("missed a video chat")
        ) {
          console.log(
            `[Instafn Message Logger]  Skipping non-text message: "${originalText}"`
          );
          return;
        }

        // Cleanup if store is getting too large
        if (messageStore.size >= MAX_STORE_SIZE) {
          cleanupOldMessages();
        }

        // Store the message (don't overwrite if already exists from WebSocket)
        if (!messageStore.has(messageId)) {
          messageStore.set(messageId, {
            id: messageId,
            text: text,
            timestamp: message.timestamp_ms,
            sender: message.sender_fbid,
            thread: messageThreadFbid,
            contentType: "TEXT",
            source: "graphql",
            storedAt: Date.now(),
            threadFbid: message.thread_fbid || messageThreadFbid,
            // Store full message object for reference
            raw: message,
          });
          storedCount++;
          console.log(
            `[Instafn Message Logger] 💾 Stored message [${messageId}]: "${text}"`
          );
        } else {
          console.log(
            `[Instafn Message Logger]  Message [${messageId}] already exists in store`
          );
        }
      });

      // Save thread name map after processing all messages in the thread
      if (threadNameMap.size > 0) {
        localStorage.setItem(
          STORAGE_KEY_THREAD_NAMES,
          JSON.stringify(Array.from(threadNameMap.entries()))
        );
        console.log(
          `[Instafn Message Logger] 💾 Saved ${threadNameMap.size} thread name mappings to storage`
        );
      }
    });

    console.log(
      `[Instafn Message Logger]  Processed GraphQL messages. Total stored: ${storedCount}, Store size: ${messageStore.size}`
    );
    if (storedCount > 0) {
      scheduleSaveMessageStore();
    }
    // Persist participants — the per-message set() calls above add message-level
    // thread_fbid keys that the per-thread save didn't cover.
    if (threadParticipantsMap.size > 0) {
      saveThreadParticipantsMap();
    }
    return storedCount;
  } catch (error) {
    console.error(
      "[Instafn Message Logger]  Error processing GraphQL messages:",
      error
    );
    return storedCount;
  }
}

// Extract JSON from JavaScript-wrapped GraphQL response
function extractJSONFromJS(jsCode) {
  // Instagram wraps JSON in JavaScript code
  // Look for the JSON object starting with {"data"
  const startIdx = jsCode.indexOf('{"data"');
  if (startIdx === -1) return null;

  // Find the matching closing brace by tracking depth
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < jsCode.length; i++) {
    const char = jsCode[i];
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  if (endIdx > startIdx) {
    try {
      return JSON.parse(jsCode.substring(startIdx, endIdx));
    } catch (e) {
      return null;
    }
  }

  return null;
}

// GraphQL interceptor is now handled by the injected graphql-sniffer.js script
// This function is kept for compatibility but does nothing
function setupGraphQLInterceptor() {
  // GraphQL interception is now done in the page context via graphql-sniffer.js
  // which is injected by syringe.js
}

// Listen for messages from the injected socket-sniffer and graphql-sniffer scripts
function setupPostMessageListener() {
  window.addEventListener("message", (event) => {
    // Only process messages from our injected scripts
    if (event.source !== window) {
      return;
    }

    // Handle WebSocket messages
    if (
      event.data?.source === "instafn-websocket" &&
      event.data.type === "websocket-message"
    ) {
      // Parse and process the message
      const parsed = parseWebSocketMessage(
        event.data.data,
        event.data.dataType
      );
      if (parsed) {
        processMessage(parsed, event.data.url);
      }
    }

    // Handle GraphQL responses
    if (
      event.data?.source === "instafn-graphql" &&
      event.data.type === "graphql-response"
    ) {
      console.log(
        "[Instafn Message Logger] 📡 GraphQL response received from page context"
      );
      const responseText = event.data.data;

      if (responseText) {
        console.log(
          "[Instafn Message Logger] 📄 Response length:",
          responseText.length
        );
        console.log(
          "[Instafn Message Logger] 📄 Response preview:",
          responseText.substring(0, 500)
        );

        // Extract JSON from JavaScript wrapper
        const extracted = extractJSONFromJS(responseText);
        if (extracted) {
          console.log(
            "[Instafn Message Logger]  Extracted JSON from GraphQL response"
          );
          const messageCount = processGraphQLMessages(extracted);
          console.log(
            `[Instafn Message Logger] 💾 Stored ${messageCount} messages from GraphQL`
          );
        } else {
          try {
            const data = JSON.parse(responseText);
            console.log(
              "[Instafn Message Logger]  Parsed GraphQL response as JSON"
            );
            const messageCount = processGraphQLMessages(data);
            console.log(
              `[Instafn Message Logger] 💾 Stored ${messageCount} messages from GraphQL`
            );
          } catch (e) {
            console.log(
              "[Instafn Message Logger]  Failed to parse GraphQL response:",
              e.message
            );
          }
        }
      }
    }
  });
}

// Export function to get message store (for message viewer)
function getMessageStore() {
  return messageStore;
}

// Export function to get deleted messages store
function getDeletedMessagesStore() {
  return deletedMessagesStore;
}

// How many recent messages to keep in the persisted index. The in-memory store
// can hold MAX_STORE_SIZE, but we cap what we write to localStorage so the index
// survives reloads (to match unsends) without risking the storage quota.
const PERSISTED_MESSAGE_LIMIT = 2500;

let saveMessageStoreTimer = null;

// Debounced persist — many messages can arrive in a burst; batch the writes.
function scheduleSaveMessageStore() {
  if (saveMessageStoreTimer) return;
  saveMessageStoreTimer = setTimeout(() => {
    saveMessageStoreTimer = null;
    saveMessageStore();
  }, 3000);
}

// Persist a slim copy of the message index (no bulky `raw`) so a deletion that
// arrives in a later session can still be matched to its original message.
function saveMessageStore() {
  try {
    const entries = Array.from(messageStore.values())
      .sort((a, b) => (a.storedAt || 0) - (b.storedAt || 0))
      .slice(-PERSISTED_MESSAGE_LIMIT)
      .map((m) => ({
        id: m.id,
        text: m.text,
        timestamp: m.timestamp,
        sender: m.sender,
        thread: m.thread,
        contentType: m.contentType,
        threadFbid: m.threadFbid,
        storedAt: m.storedAt,
      }));
    localStorage.setItem(STORAGE_KEY_MESSAGE_STORE, JSON.stringify(entries));
  } catch (e) {
    // Most likely a quota error — retry once with a smaller slice.
    try {
      const entries = Array.from(messageStore.values())
        .sort((a, b) => (a.storedAt || 0) - (b.storedAt || 0))
        .slice(-500)
        .map((m) => ({
          id: m.id,
          text: m.text,
          timestamp: m.timestamp,
          sender: m.sender,
          thread: m.thread,
          contentType: m.contentType,
          threadFbid: m.threadFbid,
          storedAt: m.storedAt,
        }));
      localStorage.setItem(STORAGE_KEY_MESSAGE_STORE, JSON.stringify(entries));
    } catch (e2) {
      console.error("[Instafn Message Logger] Error saving message store:", e2);
    }
  }
}

// Load the persisted message index so deletions of messages from earlier
// sessions can be matched. Skips entries past the TTL.
function loadMessageStore() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_MESSAGE_STORE);
    if (!stored) return;
    const now = Date.now();
    const entries = JSON.parse(stored);
    let loaded = 0;
    entries.forEach((m) => {
      if (!m || !m.id) return;
      if (m.timestamp && now - parseInt(m.timestamp) > MESSAGE_TTL) return;
      if (!messageStore.has(m.id)) {
        messageStore.set(m.id, { ...m, source: m.source || "restored" });
        loaded++;
      }
    });
    console.log(
      `[Instafn Message Logger] 📥 Restored ${loaded} messages into the index from storage`
    );
  } catch (e) {
    console.error("[Instafn Message Logger] Error loading message store:", e);
  }
}

// Save deleted messages to localStorage
function saveDeletedMessages() {
  try {
    const messagesArray = Array.from(deletedMessagesStore.entries()).map(
      ([id, msg]) => ({
        id,
        ...msg,
      })
    );
    localStorage.setItem(
      STORAGE_KEY_DELETED_MESSAGES,
      JSON.stringify(messagesArray)
    );
  } catch (e) {
    console.error("[Instafn Message Logger] Error saving deleted messages:", e);
  }
}

// Load deleted messages from localStorage
function loadDeletedMessages() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_DELETED_MESSAGES);
    if (stored) {
      const messagesArray = JSON.parse(stored);
      messagesArray.forEach((msg) => {
        deletedMessagesStore.set(msg.id, msg);
      });
      console.log(
        `[Instafn Message Logger] 📥 Loaded ${messagesArray.length} deleted messages from storage`
      );
    }
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error loading deleted messages:",
      e
    );
  }
}

// Save sender username map to localStorage
function saveSenderUsernameMap() {
  try {
    const mapArray = Array.from(senderUsernameMap.entries());
    localStorage.setItem(
      STORAGE_KEY_SENDER_USERNAMES,
      JSON.stringify(mapArray)
    );
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error saving sender username map:",
      e
    );
  }
}

// Load sender username map from localStorage
function loadSenderUsernameMap() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_SENDER_USERNAMES);
    if (stored) {
      const mapArray = JSON.parse(stored);
      mapArray.forEach(([fbid, username]) => {
        senderUsernameMap.set(String(fbid), username);
      });
      console.log(
        `[Instafn Message Logger] 📥 Loaded ${mapArray.length} sender username mappings from storage`
      );
    }
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error loading sender username map:",
      e
    );
  }
}

// Load current user Facebook ID from localStorage
function loadCurrentUserFbid() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_CURRENT_USER_FBID);
    if (stored) {
      currentUserFbid = stored;
      console.log(
        `[Instafn Message Logger] 📥 Loaded current user FBID: ${currentUserFbid}`
      );
    }
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error loading current user FBID:",
      e
    );
  }
}

// Load thread name map from localStorage
function loadThreadNameMap() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_THREAD_NAMES);
    if (stored) {
      const mapArray = JSON.parse(stored);
      mapArray.forEach(([threadId, threadName]) => {
        threadNameMap.set(String(threadId), threadName);
      });
      console.log(
        `[Instafn Message Logger] 📥 Loaded ${mapArray.length} thread name mappings from storage`
      );
    } else {
      console.log(
        `[Instafn Message Logger]  No thread name mappings found in storage. Thread names will be rebuilt automatically when you load DMs or receive messages.`
      );
    }
  } catch (e) {
    console.error("[Instafn Message Logger] Error loading thread name map:", e);
    console.log(
      `[Instafn Message Logger]  Thread names will be rebuilt automatically when you load DMs or receive messages.`
    );
  }
}

// Save thread participants map to localStorage
function saveThreadParticipantsMap() {
  try {
    localStorage.setItem(
      STORAGE_KEY_THREAD_PARTICIPANTS,
      JSON.stringify(Array.from(threadParticipantsMap.entries()))
    );
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error saving thread participants map:",
      e
    );
  }
}

// Load thread participants map from localStorage
function loadThreadParticipantsMap() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_THREAD_PARTICIPANTS);
    if (stored) {
      const mapArray = JSON.parse(stored);
      mapArray.forEach(([threadId, fbids]) => {
        if (Array.isArray(fbids)) {
          threadParticipantsMap.set(String(threadId), fbids.map(String));
        }
      });
      console.log(
        `[Instafn Message Logger] 📥 Loaded ${mapArray.length} thread participant mappings from storage`
      );
    }
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error loading thread participants map:",
      e
    );
  }
}

// Save thread display-name map to localStorage
function saveThreadDisplayNameMap() {
  try {
    localStorage.setItem(
      STORAGE_KEY_THREAD_DISPLAY_NAMES,
      JSON.stringify(Array.from(threadDisplayNameMap.entries()))
    );
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error saving thread display-name map:",
      e
    );
  }
}

// Load thread display-name map from localStorage
function loadThreadDisplayNameMap() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_THREAD_DISPLAY_NAMES);
    if (stored) {
      const mapArray = JSON.parse(stored);
      mapArray.forEach(([threadId, name]) => {
        threadDisplayNameMap.set(String(threadId), name);
      });
      console.log(
        `[Instafn Message Logger] 📥 Loaded ${mapArray.length} thread display names from storage`
      );
    }
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error loading thread display-name map:",
      e
    );
  }
}

// Instagram chrome strings that are headings/h1s elsewhere on the page (global
// nav, account switcher, our own modal). The old page-wide querySelector grabbed
// these by mistake — e.g. a group chat was named "Switch accounts" because the
// account-switcher heading matched before the conversation header did.
const HEADER_BLOCKLIST = new Set([
  "Messages",
  "Switch accounts",
  "Switch",
  "Notifications",
  "Instagram",
  "Home",
  "Search",
  "Explore",
  "Reels",
  "Create",
  "Profile",
  "Settings",
  "Direct",
  "Threads",
  "Meta",
  "More",
  "Your messages",
  "Message requests",
  "New message",
  "No posts yet",
  "Deleted Messages",
]);

function isBlockedHeaderText(text) {
  return HEADER_BLOCKLIST.has(text);
}

// Read the title shown in the header of the currently-open conversation. Scoped
// to the conversation pane (role="main") and filtered so global nav, popovers,
// dialogs (including our own viewer) and known chrome strings can't be captured
// as a thread name.
function readOpenThreadHeaderTitle() {
  const main = document.querySelector('div[role="main"]') || document;
  const selectors = [
    'div[role="heading"][aria-level="1"]',
    'header [role="heading"]',
    "header h1",
    'header span[dir="auto"]',
  ];
  for (const selector of selectors) {
    const elements = main.querySelectorAll(selector);
    for (const element of elements) {
      // Never trust headings that live in the global nav or any dialog/popover
      // (the account switcher, menus, our own "Deleted Messages" modal, etc.).
      if (
        element.closest('[role="navigation"]') ||
        element.closest('[role="dialog"]')
      ) {
        continue;
      }
      // Must be actually rendered — a hidden off-screen heading isn't the header.
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const text = element.textContent && element.textContent.trim();
      if (
        text &&
        text.length > 0 &&
        text.length < 200 &&
        !isBlockedHeaderText(text) &&
        !/^\d+$/.test(text)
      ) {
        return text;
      }
    }
  }
  return null;
}

// Capture the open conversation's header text, keyed by the thread id in the URL.
// Both come from the same open thread, so this can't mis-attribute names across
// threads the way the old WebSocket-time DOM scraping did.
//
// We require the thread to have been open for one full tick before capturing,
// because right after navigating the URL updates before the header DOM does —
// capturing immediately could pair thread B's id with thread A's stale header.
let lastTickThreadId = null;
function captureOpenThreadDisplayName() {
  try {
    const match = window.location.pathname.match(/\/direct\/t\/(\d+)/);
    if (!match) {
      lastTickThreadId = null;
      return;
    }
    const threadId = String(match[1]);
    const wasStable = lastTickThreadId === threadId;
    lastTickThreadId = threadId;
    if (!wasStable) return; // first tick on this thread — let the header settle

    const title = readOpenThreadHeaderTitle();
    if (!title) return;
    if (threadDisplayNameMap.get(threadId) === title) return;
    threadDisplayNameMap.set(threadId, title);
    saveThreadDisplayNameMap();
    console.log(
      `[Instafn Message Logger] 🏷️ Captured thread name "${title}" for open thread ${threadId}`
    );
  } catch (e) {
    // Ignore
  }
}

// One-time cleanup of the thread-name map. An earlier version scraped the
// on-screen conversation header and stored it as a "thread name", which attached
// the wrong name (often a DM partner's username, or UI text like "No posts yet")
// to unrelated threads. We can't tell a real group name from a scraped one after
// the fact, so we drop every non-empty entry and keep only the "" markers (which
// reliably came from GraphQL and mean "unnamed group"). Real group names are
// re-added cleanly the next time the DM inbox loads.
function migrateThreadNames() {
  try {
    if (localStorage.getItem(STORAGE_KEY_THREAD_NAMES_MIGRATED)) return;

    let removed = 0;
    for (const [key, value] of Array.from(threadNameMap.entries())) {
      if (value !== "") {
        threadNameMap.delete(key);
        removed++;
      }
    }
    localStorage.setItem(
      STORAGE_KEY_THREAD_NAMES,
      JSON.stringify(Array.from(threadNameMap.entries()))
    );
    localStorage.setItem(STORAGE_KEY_THREAD_NAMES_MIGRATED, "1");
    console.log(
      `[Instafn Message Logger] 🧹 Cleaned ${removed} scraped thread name(s). Real group names rebuild on next inbox load.`
    );
  } catch (e) {
    console.error(
      "[Instafn Message Logger] Error migrating thread names:",
      e
    );
  }
}

// Drop any captured header names that are actually Instagram chrome (e.g.
// "Switch accounts" wrongly attached to a group chat by the old page-wide
// scrape). Runs every load — not one-time gated — so bad entries from a prior
// build are cleaned up. Real names are re-captured from the scoped header.
function purgeBadThreadDisplayNames() {
  try {
    let removed = 0;
    for (const [key, value] of Array.from(threadDisplayNameMap.entries())) {
      if (typeof value !== "string" || isBlockedHeaderText(value.trim())) {
        threadDisplayNameMap.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      saveThreadDisplayNameMap();
      console.log(
        `[Instafn Message Logger] 🧹 Purged ${removed} chrome-string thread name(s) (e.g. "Switch accounts").`
      );
    }
  } catch (e) {
    // Ignore
  }
}

function initMessageLogger() {
  // Load persisted data from localStorage
  loadMessageStore();
  loadDeletedMessages();
  loadSenderUsernameMap();
  loadCurrentUserFbid();
  loadThreadNameMap();
  loadThreadParticipantsMap();
  loadThreadDisplayNameMap();
  migrateThreadNames();
  purgeBadThreadDisplayNames();

  // Capture the open conversation's name from its header (keyed by the URL's
  // thread id). The header loads asynchronously and changes as you navigate
  // between threads, so poll on a light interval.
  captureOpenThreadDisplayName();
  setInterval(captureOpenThreadDisplayName, 1500);

  // Set up listener for messages from injected script (WebSocket)
  setupPostMessageListener();

  // Set up GraphQL interceptor to capture initial messages
  setupGraphQLInterceptor();

  // Expose message store on window for message viewer
  if (!window.Instafn) window.Instafn = {};
  window.Instafn.getMessageStore = getMessageStore;
  window.Instafn.getDeletedMessagesStore = getDeletedMessagesStore;
  window.Instafn.saveDeletedMessages = saveDeletedMessages;

  // Save sender username map periodically
  setInterval(() => {
    if (senderUsernameMap.size > 0) {
      saveSenderUsernameMap();
    }
  }, 30 * 1000); // Every 30 seconds
}


module.exports.getMessageStore = getMessageStore;
module.exports.getDeletedMessagesStore = getDeletedMessagesStore;
module.exports.initMessageLogger = initMessageLogger;
});


defineModule("features/message-logger/syringe.js", function (module, exports, require) {
/**
 * Syringe script - Injects socket-sniffer.js and graphql-sniffer.js into the page context
 */

(function() {
  'use strict';
  
  // Only inject if we're in the main frame (not in an iframe)
  if (window !== window.top) {
    return;
  }
  
  function injectScript(src) {
    try {
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL(src);
      s.onload = function() {
        this.remove();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.error('[Instafn Message Logger] Error injecting script:', e);
    }
  }
  
  // Inject WebSocket sniffer
  injectScript('content/features/message-logger/socket-sniffer.js');
  
  // Inject GraphQL sniffer
  injectScript('content/features/message-logger/graphql-sniffer.js');
})();


});


defineModule("features/message-logger/thread-name.js", function (module, exports, require) {
/**
 * Shared thread display-name resolution for the message logger.
 *
 * Every ID here is an Instagram interop FBID — the same space used by a message's
 * sender_fbid, the viewer's own fbid, and a thread's participant fbids. That lets
 * us name a 1:1 DM as "the participant who isn't you", which is reliable. The old
 * approach scraped whatever conversation header happened to be on screen when a
 * WebSocket event arrived, which attributed the wrong thread to most messages.
 */

/**
 * @param {Object} args
 * @param {string|number} args.threadId        thread_fbid from the delta / stored message
 * @param {string|number} [args.senderFbid]    fbid of whoever sent the message
 * @param {Map<string,string[]>} [args.participantsMap]  threadKey -> participant fbids
 * @param {Map<string,string>}   [args.threadNameMap]    threadKey -> group name ("" = unnamed group)
 * @param {Map<string,string>}   [args.senderUsernameMap] fbid -> username
 * @param {string|number} [args.currentUserFbid]
 * @returns {string}
 */
function resolveThreadDisplayName({
  threadId,
  senderFbid,
  participantsMap,
  threadNameMap,
  displayNameMap,
  senderUsernameMap,
  currentUserFbid,
}) {
  const tid = threadId == null ? "" : String(threadId);
  const me = currentUserFbid == null ? "" : String(currentUserFbid);
  const participants = participantsMap ? participantsMap.get(tid) : null;
  // Header text captured while this exact thread was open (see
  // captureOpenThreadDisplayName). Used as a fallback, never as a group/DM
  // signal, so it can't reintroduce the old misclassification.
  const headerName = displayNameMap ? displayNameMap.get(tid) : undefined;

  // Group vs DM. Post-migration the thread-name map only holds real group names
  // and "" markers, so any entry means "group". A participant count > 2 is an
  // extra signal. We OR them: a DM never has a name entry and never exceeds 2
  // participants, so this can't misclassify a DM as a group.
  const hasNameEntry = threadNameMap ? threadNameMap.has(tid) : false;
  const groupName = hasNameEntry ? threadNameMap.get(tid) : undefined;
  const isGroup =
    hasNameEntry || (Array.isArray(participants) && participants.length > 2);

  if (isGroup) {
    // A group with a custom name from GraphQL: show it.
    if (typeof groupName === "string" && groupName.trim() !== "") {
      return groupName;
    }
    // Otherwise the name we read from the conversation header (what Instagram
    // itself displays, including the member list for unnamed groups).
    if (headerName) return headerName;
    // Or reconstruct the member list from participant usernames.
    if (participants && participants.length) {
      const members = participants
        .filter((p) => String(p) !== me)
        .map((p) => senderUsernameMap && senderUsernameMap.get(String(p)))
        .filter(Boolean);
      if (members.length) return members.join(", ");
      return `Group (${participants.length} people)`;
    }
    return "Group chat";
  }

  // DM: name it after the other participant. Only trust this when we actually
  // know who "you" are — without currentUserFbid we can't tell the partner from
  // the viewer, so fall through to the sender-based path instead of guessing.
  if (participants && me) {
    const partner = participants.find((p) => String(p) !== me);
    if (partner != null) {
      const username = senderUsernameMap && senderUsernameMap.get(String(partner));
      if (username) return username;
    }
  }

  // Fallback for threads we never captured from a GraphQL inbox load: if the
  // deleted message came from the other person, that sender is the partner.
  if (senderFbid && String(senderFbid) !== me) {
    const username = senderUsernameMap && senderUsernameMap.get(String(senderFbid));
    if (username) return username;
  }

  // Last resort before the raw id: the header we saw while the thread was open.
  if (headerName) return headerName;

  // Nothing resolved — show the raw thread id rather than a wrong name.
  return tid || "Unknown";
}


module.exports.resolveThreadDisplayName = resolveThreadDisplayName;
});


defineModule("features/story-blocking/manualSeenButton.js", function (module, exports, require) {
var { showToast } = require("ui/toast.js");

const EYE_ICON_PATH =
  '<path d="M2 12s3-6 10-6S22 12 22 12s-3 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"></circle>';

let teardown = null;

function showSeenToast() {
  showToast("Marked as seen", {
    id: "instafn-story-seen-toast",
    duration: 1000,
  });
}

function markCurrentStoryAsSeen() {
  // Allow seen requests to go through and replay the most recent one
  // This marks the current story as seen regardless of progress (0%, 90%, etc.)
  window.postMessage(
    { source: "instafn", type: "ALLOW_STORY_SEEN", ms: 3000 },
    "*"
  );
  window.postMessage({ source: "instafn", type: "MARK_STORY_SEEN" }, "*");
}

function removeExistingButtons() {
  document
    .querySelectorAll('[data-instafn-story-seen-btn="true"]')
    .forEach((btn) => btn.remove());
}

function isStoryContext() {
  // Only show button on actual story pages
  // Check URL first - most reliable indicator
  if (window.location.pathname.includes("/stories/")) {
    return true;
  }

  // Additional checks for story viewer (modal/dialog)
  // Stories typically have a reply textarea AND are in a dialog/modal
  const hasReplyTextarea = !!document.querySelector(
    'textarea[placeholder*="Reply to"]'
  );
  const hasStoryDialog =
    !!document.querySelector('[role="dialog"]') ||
    !!document.querySelector('article[role="presentation"]');

  // Only consider it a story if we have both the reply textarea AND a dialog/modal
  // This prevents false positives on regular posts/reels
  if (hasReplyTextarea && hasStoryDialog) {
    // Double-check: stories usually have a "Next" button in the dialog
    const hasNextButton = !!document.querySelector('svg[aria-label="Next"]');
    if (hasNextButton) {
      return true;
    }
  }

  return false;
}

function copyLayout(templateButton, button) {
  try {
    const computed = getComputedStyle(templateButton);
    const ensure = (prop, fallback) => {
      if (!button.style[prop]) {
        button.style[prop] =
          templateButton.style[prop] || computed[prop] || fallback;
      }
    };
    ensure("display", "inline-flex");
    ensure("flex", "0 0 auto");
    ensure("alignItems", "center");
    ensure("justifyContent", "center");
    ensure("alignSelf", "center");
    ensure("flexDirection", "row");
    ensure("verticalAlign", "middle");
    ensure("marginRight", "8px");
    ensure("marginLeft", "0px");

    // Avoid inheriting absolute positioning from the heart
    button.style.position = "static";
    button.style.right = "";
    button.style.left = "";
    button.style.top = "";
    button.style.bottom = "";
    button.style.transform = "none";
    button.style.background = "transparent";
    button.style.border = "none";

    // Nudge order to appear before heart in flex layouts
    const heartOrder = parseInt(computed.order || "0", 10);
    if (!Number.isNaN(heartOrder)) {
      button.style.order = (heartOrder - 1).toString();
    }

    // Neutral color so it doesn’t inherit the red liked state
    const neutral = "var(--ig-primary-text, #fff)";
    button.style.color = neutral;
  } catch (_) {
    // ignore styling copy failures
  }
}

function createManualSeenButton(templateButton) {
  const button = templateButton.cloneNode(true);
  button.dataset.instafnStorySeenBtn = "true";
  button.setAttribute("aria-label", "Mark story as seen");
  button.title = "Mark story as seen";
  button.tabIndex = 0;
  button.setAttribute("aria-pressed", "false");

  copyLayout(templateButton, button);

  const svg = button.querySelector("svg");
  if (svg) {
    svg.setAttribute("aria-label", "Mark story as seen");
    svg.setAttribute("role", "img");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("height", "24");
    svg.setAttribute("width", "24");
    svg.innerHTML = EYE_ICON_PATH;
    svg.style.color = "var(--ig-primary-text, #fff)";
    svg.style.fill = "none";
    svg.style.stroke = "currentColor";
    svg.querySelectorAll("path,circle").forEach((p) => {
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
    });
  } else {
    const span = document.createElement("span");
    span.innerHTML = `<svg aria-label="Mark story as seen" role="img" viewBox="0 0 24 24" height="24" width="24">${EYE_ICON_PATH}</svg>`;
    button.appendChild(span);
  }

  const handleTrigger = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    button.setAttribute("data-instafn-story-seen-active", "true");
    markCurrentStoryAsSeen();
    showSeenToast();
    setTimeout(() => {
      button.removeAttribute("data-instafn-story-seen-active");
    }, 1200);
  };

  button.addEventListener("click", handleTrigger);
  button.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      handleTrigger(e);
    }
  });

  return button;
}

function findActionRows() {
  // Only find action rows within story contexts
  // Stories typically have a reply textarea nearby
  const storyContainer =
    document.querySelector('[role="dialog"]') ||
    document.querySelector('article[role="presentation"]') ||
    document.body;

  const hearts = Array.from(
    storyContainer.querySelectorAll(
      'svg[aria-label="Like"], svg[aria-label="Unlike"]'
    )
  );

  return hearts
    .map((heart) => {
      const heartButton = heart.closest(
        'button, [role="button"], div[role="button"]'
      );
      if (!heartButton) return null;

      // Verify this heart is within a story context
      // Stories have a reply textarea nearby
      const hasNearbyReply =
        !!heartButton
          .closest('[role="dialog"]')
          ?.querySelector('textarea[placeholder*="Reply to"]') ||
        !!heartButton
          .closest('article[role="presentation"]')
          ?.querySelector('textarea[placeholder*="Reply to"]');

      if (!hasNearbyReply && !window.location.pathname.includes("/stories/")) {
        return null; // Not in a story context
      }

      // Prefer a row that also contains send/direct
      let row = heartButton;
      for (let i = 0; i < 8 && row; i++) {
        if (
          row.querySelector('svg[aria-label="Direct"], svg[aria-label="Send"]')
        ) {
          break;
        }
        row = row.parentElement;
      }

      // Fallback to immediate parent
      if (!row) row = heartButton.parentElement;

      return row ? { row, heartButton } : null;
    })
    .filter(Boolean);
}

function setupManualSeenButton() {
  let lastHref = window.location.href;
  let rafId = null;
  let hrefPollId = null;
  let intervalId = null;

  const ensureButtonExists = () => {
    // Always check story context first - remove buttons if not in story
    if (!isStoryContext()) {
      removeExistingButtons();
      return;
    }

    const actions = findActionRows();
    if (!actions.length) return;

    // Additional safety: verify we're still in story context before adding buttons
    if (!isStoryContext()) {
      return;
    }

    actions.forEach(({ row, heartButton }) => {
      if (!row || !heartButton) return;
      // Place relative to the heart's actual parent to avoid NotFoundError
      const parent = heartButton.parentNode;
      if (!parent || !parent.contains(heartButton)) return;
      // Ensure the container lays out children horizontally
      if (!parent.style.display) parent.style.display = "flex";
      if (!parent.style.alignItems) parent.style.alignItems = "center";
      if (
        parent.querySelector &&
        parent.querySelector('[data-instafn-story-seen-btn="true"]')
      )
        return;

      const manualButton = createManualSeenButton(heartButton);
      parent.insertBefore(manualButton, heartButton);
    });
  };

  const scheduleRefresh = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      ensureButtonExists();
    });
  };

  const observer = new MutationObserver(scheduleRefresh);
  const target = document.body || document.documentElement;
  if (target) {
    observer.observe(target, { childList: true, subtree: true });
  }

  document.addEventListener("click", scheduleRefresh, true);
  window.addEventListener("popstate", scheduleRefresh);
  window.addEventListener("hashchange", scheduleRefresh);
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      scheduleRefresh();
    }
  });

  hrefPollId = window.setInterval(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      removeExistingButtons();
    }
    scheduleRefresh();
  }, 400);

  // Extra safety: lightweight poll to reassert button in case React re-renders
  intervalId = window.setInterval(() => {
    ensureButtonExists();
  }, 600);

  scheduleRefresh();

  return () => {
    observer.disconnect();
    document.removeEventListener("click", scheduleRefresh, true);
    window.removeEventListener("popstate", scheduleRefresh);
    window.removeEventListener("hashchange", scheduleRefresh);
    if (hrefPollId) {
      clearInterval(hrefPollId);
      hrefPollId = null;
    }
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (rafId) cancelAnimationFrame(rafId);
    removeExistingButtons();
  };
}

function initManualStorySeenButton(enabled) {
  if (!enabled) {
    if (teardown) {
      teardown();
      teardown = null;
    }
    return;
  }

  if (teardown) return;
  teardown = setupManualSeenButton();
}


module.exports.initManualStorySeenButton = initManualStorySeenButton;
});


defineModule("features/typing-receipt-blocker/index.js", function (module, exports, require) {
/**
 * Typing Receipt Blocker
 * Blocks typing indicators from being sent in Instagram messages
 */

var { injectScript } = require("utils/scriptInjector.js");

// Store original functions
let originalFetch = null;
let originalXHROpen = null;
let originalXHRSend = null;
let originalWsHookBefore = null;
let originalWsHookAfter = null;
let isIntercepted = false;

// Check if feature is enabled (checks both the flag and the window object)
const checkEnabled = () => {
  return window.Instafn?.blockTypingReceipts === true;
};

function initTypingReceiptBlocker(enabled) {
  // Send flag to page context via postMessage (avoids CSP issues)
  function setFlag() {
    window.postMessage(
      {
        source: "instafn-content",
        type: "set-typing-blocker",
        enabled: enabled,
      },
      "*"
    );
  }

  // Set flag immediately
  setFlag();

  // Inject the WebSocket interceptor (it checks the flag dynamically)
  injectScript(
    "content/features/typing-receipt-blocker/websocket-interceptor.js",
    {
      once: true,
      onLoad: setFlag,
    }
  );

  // Set up interceptors (they check the enabled flag dynamically)
  // Only set up once, then they check the flag on each call
  if (!isIntercepted) {
    interceptTypingReceipts();
  }
}

function interceptTypingReceipts() {
  if (isIntercepted) {
    return; // Already intercepted
  }

  // Store original functions
  originalFetch = window.fetch;
  originalXHROpen = XMLHttpRequest.prototype.open;
  originalXHRSend = XMLHttpRequest.prototype.send;

  const setupWsHook = () => {
    if (typeof window.wsHook !== "undefined") {
      // Store original if not already stored
      if (originalWsHookBefore === null) {
        originalWsHookBefore = window.wsHook.before;
      }
      if (originalWsHookAfter === null) {
        originalWsHookAfter = window.wsHook.after;
      }

      window.wsHook.before = (data, url) => {
        // Check if enabled before processing
        if (!checkEnabled()) {
          return originalWsHookBefore ? originalWsHookBefore(data, url) : data;
        }

        try {
          if (
            url &&
            (url.includes("edge-chat.instagram.com") ||
              url.includes("instagram.com")) &&
            typeof data === "string"
          ) {
            if (
              data.includes('"is_typing":1') ||
              data.includes('"is_typing": 1') ||
              (data.includes('"type":4') && data.includes('"is_typing":1'))
            ) {
              return data.replace(/"is_typing":\s*1/g, '"is_typing":0');
            }
          }
        } catch (error) {
          console.log("Instafn: Error processing typing receipt:", error);
        }
        return originalWsHookBefore ? originalWsHookBefore(data, url) : data;
      };
      window.wsHook.after = (event) => {
        return originalWsHookAfter ? originalWsHookAfter(event) : event;
      };
    } else {
      setTimeout(setupWsHook, 100);
    }
  };
  setupWsHook();

  window.fetch = function(...args) {
    // Check if enabled before processing
    if (!checkEnabled()) {
      return originalFetch.apply(this, args);
    }

    const [url, options] = args;
    if (
      typeof url === "string" &&
      url.includes("edge-chat.instagram.com/chat") &&
      options?.body
    ) {
      try {
        let body = options.body;
        if (typeof body === "string") {
          try {
            const parsed = JSON.parse(body);
            if (parsed.payload) {
              const payload = JSON.parse(parsed.payload);
              if (payload.is_typing === 1) {
                payload.is_typing = 0;
                parsed.payload = JSON.stringify(payload);
                options.body = JSON.stringify(parsed);
              }
            }
          } catch (e) {
            if (body.includes('"is_typing":1')) {
              options.body = body.replace('"is_typing":1', '"is_typing":0');
            }
          }
        } else if (body instanceof FormData) {
          const formData = new FormData();
          for (let [key, value] of body.entries()) {
            if (key === "payload" && typeof value === "string") {
              try {
                const payload = JSON.parse(value);
                if (payload.is_typing === 1) {
                  payload.is_typing = 0;
                  formData.append(key, JSON.stringify(payload));
                } else {
                  formData.append(key, value);
                }
              } catch (e) {
                formData.append(key, value);
              }
            } else {
              formData.append(key, value);
            }
          }
          options.body = formData;
        }
      } catch (error) {
        console.log("Instafn: Error processing typing receipt:", error);
      }
    }
    return originalFetch.apply(this, args);
  };

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    return originalXHROpen.apply(this, [method, url, ...args]);
  };
  XMLHttpRequest.prototype.send = function(data) {
    // Check if enabled before processing
    if (!checkEnabled()) {
      return originalXHRSend.call(this, data);
    }

    if (this._url && this._url.includes("edge-chat.instagram.com/chat")) {
      if (data && typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          if (parsed.payload) {
            const payload = JSON.parse(parsed.payload);
            if (payload.is_typing === 1) {
              payload.is_typing = 0;
              parsed.payload = JSON.stringify(payload);
              data = JSON.stringify(parsed);
            }
          }
        } catch (e) {
          if (data.includes('"is_typing":1')) {
            data = data.replace('"is_typing":1', '"is_typing":0');
          }
        }
      }
    }
    return originalXHRSend.call(this, data);
  };

  isIntercepted = true;
}


module.exports.initTypingReceiptBlocker = initTypingReceiptBlocker;
});


defineModule("features/call-timer/index.js", function (module, exports, require) {
var { injectStylesheet } = require("utils/styleLoader.js");
var { watchUrlChanges } = require("utils/domObserver.js");
var { watchForElement } = require("utils/domObserver.js");

let timerInterval = null;
let startTime = null;
let timerElement = null;

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      secs
    ).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateTimer() {
  if (!timerElement || !startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  timerElement.textContent = formatTime(elapsed);
}

function injectTimer() {
  if (timerElement?.parentElement) return; // Already injected

  // Find "people" text
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  let node;
  while ((node = walker.nextNode())) {
    if (/^\d+\s+people?$/.test(node.textContent.trim())) {
      const parent = node.parentElement;
      if (!parent) continue;

      // Create timer
      timerElement = document.createElement("span");
      timerElement.className = "instafn-call-timer";
      timerElement.textContent = "00:00";

      // Insert after the "people" element: separator first, then timer
      const separator = document.createElement("span");
      separator.className = "instafn-call-timer-separator";
      separator.textContent = "·";

      parent.parentElement?.insertBefore(separator, parent.nextSibling);
      separator.parentElement?.insertBefore(
        timerElement,
        separator.nextSibling
      );

      // Start timer
      startTime = Date.now();
      if (timerInterval) clearInterval(timerInterval);
      timerInterval = setInterval(updateTimer, 1000);
      return;
    }
  }
}

function cleanup() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (timerElement) {
    timerElement.remove();
    timerElement = null;
  }
  startTime = null;
}

function initCallTimer(enabled = true) {
  if (!enabled) {
    cleanup();
    return;
  }

  injectStylesheet(
    "content/features/call-timer/call-timer.css",
    "instafn-call-timer"
  );

  // Only run on call pages
  if (!window.location.pathname.includes("/call/")) return;

  // Try to inject immediately
  if (document.body) {
    injectTimer();
  }

  // Watch for element to appear
  watchForElement(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    let node;
    while ((node = walker.nextNode())) {
      if (/^\d+\s+people?$/.test(node.textContent.trim())) {
        return node.parentElement;
      }
    }
    return null;
  }, injectTimer);

  // Watch for URL changes
  watchUrlChanges(() => {
    cleanup();
    if (window.location.pathname.includes("/call/")) {
      setTimeout(injectTimer, 100);
    }
  });
}


module.exports.initCallTimer = initCallTimer;
});


defineModule("features/reel-speed-hold/index.js", function (module, exports, require) {
/**
 * Reel 2× Speed (Hold to Fast-Forward)
 *
 * Press-and-hold a reel OR a regular feed-post video — or hold the spacebar
 * while a reel is on screen — to play it at 2× speed. Releasing restores normal
 * speed. A semantic pill with a fast-forward icon ("2× speed") appears at the
 * top of the video while active.
 *
 * The spacebar path stays reel-only: on the home feed, Space scrolls the page,
 * so only press-and-hold (not Space) fast-forwards feed videos.
 *
 * Reels use a native <video>, so this just drives `playbackRate`. The only
 * subtlety is Instagram toggles play/pause on a click: we distinguish a hold
 * from a tap with a short threshold and swallow the trailing click after a hold
 * so the video doesn't pause when the user lets go.
 */

const STYLE_ID = "instafn-reel-speed-style";
const OVERLAY_ID = "instafn-reel-speed-overlay";
const FAST_RATE = 2;
const HOLD_THRESHOLD_MS = 180; // below this, treat as a normal tap (play/pause)

let enabled = false;

// Active-hold state
let activeVideo = null;
let savedRate = 1;
let holdTimer = null;
let pointerHeld = false;
let spaceHeld = false;
let swallowNextClick = false;
let swallowResetTimer = null;
let positionRAF = null;

function isReelVideo(video) {
  if (!video || video.tagName !== "VIDEO") return false;

  const path = window.location.pathname;
  // Never touch DM chat or call videos.
  if (path.includes("/direct") || path.includes("/call/")) return false;

  if (path.includes("/reels/") || path.includes("/reel/")) return true;

  // Feed / explore reels: the video sits near a reels permalink or audio link.
  let el = video;
  let depth = 0;
  while (el && depth < 12) {
    if (
      el.querySelector?.(
        'a[href*="/reels/"], a[href*="/reel/"], a[href*="/reels/audio/"]'
      )
    ) {
      return true;
    }
    el = el.parentElement;
    depth++;
  }
  return false;
}

// The press-and-hold path also covers regular feed-post videos, not just
// reels. A feed post lives inside an <article>; that wrapper distinguishes a
// real post video from avatars, explore-grid thumbnails, and other stray
// <video>s. The spacebar path intentionally does NOT use this — it stays
// reel-only (see findActiveReelVideo) so Space keeps scrolling the feed.
function isHoldableVideo(video) {
  if (!video || video.tagName !== "VIDEO") return false;
  if (isReelVideo(video)) return true;

  const path = window.location.pathname;
  if (path.includes("/direct") || path.includes("/call/")) return false;

  return !!video.closest("article");
}

// The reel <video> currently on screen (largest visible one). Used for the
// spacebar path, where there's no pointer target to key off.
function findActiveReelVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  let best = null;
  let bestArea = 0;
  for (const video of videos) {
    if (!isReelVideo(video)) continue;
    const r = video.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = visW * visH;
    if (area > bestArea) {
      bestArea = area;
      best = video;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Identical declarations to the scrubber's timestamp pill
  // (.instafn-reel-time-pill), including !important on everything — that's what
  // makes it survive Instagram's global CSS and render as the same component.
  // Only the anchor (top vs bottom) and the inline icon differ.
  // `left`/`transform` are set inline per-frame (anchored to the reel), so they
  // are intentionally NOT in this rule — an `!important` here would override the
  // inline positioning and re-center the pill on the viewport instead.
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 5px !important;
      background: rgba(0, 0, 0, 0.85) !important;
      color: white !important;
      padding: 6px 10px !important;
      border-radius: 16px !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      white-space: nowrap !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 0.15s ease !important;
      z-index: 2147483647 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    }
    #${OVERLAY_ID}.instafn-visible { opacity: 1 !important; }
    #${OVERLAY_ID} svg { display: block !important; width: 13px !important; height: 13px !important; }
    body.instafn-reel-speeding :focus,
    body.instafn-reel-speeding :focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }
  `;
  document.head.appendChild(style);
}

function getOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  ensureStyle();
  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.5a1 1 0 0 1 1.6-.8L12 10V6.3a1 1 0 0 1 1.6-.8l7.4 5.5a1 1 0 0 1 0 1.6L13.6 19a1 1 0 0 1-1.6-.8V14l-7.4 5.3A1 1 0 0 1 3 18.5z"/>
    </svg>
    <span>2x speed</span>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function positionOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay || !activeVideo) return;
  const r = activeVideo.getBoundingClientRect();
  overlay.style.left = `${r.left + r.width / 2}px`;
  overlay.style.top = `${r.top + 16}px`;
  overlay.style.transform = "translateX(-50%)";
}

function showOverlay() {
  const overlay = getOverlay();
  positionOverlay();
  // Keep it pinned to the reel while active (cheap; only runs during a hold).
  const loop = () => {
    if (!activeVideo) return;
    positionOverlay();
    positionRAF = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(positionRAF);
  positionRAF = requestAnimationFrame(loop);
  requestAnimationFrame(() => overlay.classList.add("instafn-visible"));
}

function hideOverlay() {
  cancelAnimationFrame(positionRAF);
  positionRAF = null;
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.classList.remove("instafn-visible");
}

// ---------------------------------------------------------------------------
// Speed control
// ---------------------------------------------------------------------------

function startFast(video) {
  if (!video || activeVideo) return;
  activeVideo = video;
  savedRate = video.playbackRate || 1;
  try {
    video.playbackRate = FAST_RATE;
  } catch (e) {
    /* some videos disallow rate changes */
  }
  // A reel paused by a stray click should resume when fast-forwarding.
  if (video.paused) video.play?.().catch(() => {});
  // Suppress the focus ring that keyboard (space) activation would draw.
  document.body.classList.add("instafn-reel-speeding");
  showOverlay();
}

function stopFast() {
  if (!activeVideo) return;
  try {
    activeVideo.playbackRate = savedRate || 1;
  } catch (e) {
    /* ignore */
  }
  activeVideo = null;
  document.body.classList.remove("instafn-reel-speeding");
  hideOverlay();
}

// ---------------------------------------------------------------------------
// Pointer (press-and-hold) path
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!enabled || e.button !== 0) return;
  // Any leftover swallow flag is stale by the time a new press begins.
  swallowNextClick = false;
  clearTimeout(swallowResetTimer);

  // Don't hijack the reel's overlaid controls (username, Follow, like/comment/
  // share/save/more, audio, links) — only the bare video surface.
  if (isInteractiveControl(e.target)) return;

  const video = e.target.closest?.("video") || findVideoUnderPoint(e);
  if (!video || !isHoldableVideo(video)) return;

  pointerHeld = true;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    if (pointerHeld) {
      startFast(video);
      swallowNextClick = true; // don't let the release click toggle pause
    }
  }, HOLD_THRESHOLD_MS);
}

function onPointerUp() {
  if (!enabled) return;
  pointerHeld = false;
  clearTimeout(holdTimer);
  stopFast();
  // The trailing click fires right after release; if it never comes (pointer
  // dragged off the video), clear the swallow flag so a later click is safe.
  if (swallowNextClick) {
    clearTimeout(swallowResetTimer);
    swallowResetTimer = setTimeout(() => {
      swallowNextClick = false;
    }, 350);
  }
}

// The reel video is often covered by transparent overlays, so the pointerdown
// target may not be the <video>. Hit-test the exact point: elementsFromPoint
// only includes the <video> when the cursor is genuinely within its box, so we
// must NOT descend into subtrees (that would match the reel from anywhere on
// the page, since ancestors contain the video).
function findVideoUnderPoint(e) {
  const stack = document.elementsFromPoint?.(e.clientX, e.clientY) || [];
  for (const el of stack) {
    if (el.tagName === "VIDEO") return el;
  }
  return null;
}

// Overlaid, tappable reel chrome that should keep its normal behavior.
function isInteractiveControl(target) {
  if (!target?.closest) return false;
  // The scrubber (our own timeline) — dragging it must not start fast-forward.
  if (target.closest('[class*="instafn-reel-scrubber"]')) return true;
  if (target.closest('a, [role="link"], input, textarea, [contenteditable="true"]')) {
    return true;
  }
  const labeled = target.closest("[aria-label]");
  const label = labeled?.getAttribute("aria-label") || "";
  return /^(Like|Unlike|Comment|Repost|Share|Save|Remove|More|Follow|Following|Audio)\b/i.test(
    label
  );
}

function onClickCapture(e) {
  if (swallowNextClick) {
    swallowNextClick = false;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}

// ---------------------------------------------------------------------------
// Spacebar path
// ---------------------------------------------------------------------------

function isTypingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    el.isContentEditable ||
    el.getAttribute?.("role") === "textbox"
  );
}

function onKeyDown(e) {
  if (!enabled || e.code !== "Space") return;
  if (isTypingTarget()) return;

  // Already holding: the OS keeps firing keydown while the key is down — each
  // one has the default page-scroll action, so we must keep blocking it.
  if (spaceHeld) {
    e.preventDefault();
    return;
  }

  const video = findActiveReelVideo();
  if (!video) return; // no reel on screen → leave Space alone (normal scroll)
  e.preventDefault();
  spaceHeld = true;
  startFast(video);
}

function onKeyUp(e) {
  if (e.code !== "Space" || !spaceHeld) return;
  spaceHeld = false;
  e.preventDefault();
  stopFast();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function initReelSpeedHold(isEnabled) {
  enabled = !!isEnabled;

  // Listeners are attached once; the `enabled` flag gates behavior so the
  // feature can be toggled live without leaking handlers.
  if (initReelSpeedHold._wired) return;
  initReelSpeedHold._wired = true;

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
  // Releasing outside the video (or losing focus) must also stop.
  window.addEventListener("blur", onPointerUp);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
}


module.exports.initReelSpeedHold = initReelSpeedHold;
});


defineModule("utils/domObserver.js", function (module, exports, require) {
/**
 * Reusable DOM observation utilities
 * Provides common patterns for watching DOM changes
 */

/**
 * Watch for URL changes (useful for SPA navigation)
 * @param {Function} callback - Called when URL changes
 * @returns {Function} - Cleanup function
 */
function watchUrlChanges(callback) {
  let lastUrl = location.href;

  const observer = new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = currentUrl;
      callback(currentUrl, previousUrl);
    }
  });

  observer.observe(document, { subtree: true, childList: true });

  return () => observer.disconnect();
}

/**
 * Watch for element appearance in DOM
 * @param {string|Function} selector - CSS selector or function that returns element
 * @param {Function} callback - Called when element appears
 * @param {Object} options - Options
 * @param {number} options.interval - Polling interval in ms (default: 100)
 * @param {number} options.timeout - Timeout in ms (default: 10000)
 * @returns {Function} - Cleanup function
 */
function watchForElement(selector, callback, options = {}) {
  const { interval = 100, timeout = 10000 } = options;

  let checkCount = 0;
  const maxChecks = timeout / interval;

  const check = () => {
    const element =
      typeof selector === "function"
        ? selector()
        : document.querySelector(selector);

    if (element) {
      callback(element);
      return;
    }

    checkCount++;
    if (checkCount < maxChecks) {
      setTimeout(check, interval);
    }
  };

  check();

  return () => {
    // Cleanup handled by timeout
  };
}

/**
 * Watch for DOM mutations with a selector
 * @param {string} selector - CSS selector to watch for
 * @param {Function} callback - Called when matching elements are added
 * @param {Object} options - MutationObserver options
 * @returns {Function} - Cleanup function
 */
function watchDOMChanges(selector, callback, options = {}) {
  const defaultOptions = {
    childList: true,
    subtree: true,
    ...options,
  };

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches?.(selector)) {
            callback(node);
          }
          const matches = node.querySelectorAll?.(selector);
          if (matches) {
            matches.forEach((match) => callback(match));
          }
        }
      });
    });
  });

  observer.observe(document.body || document.documentElement, defaultOptions);

  return () => observer.disconnect();
}


module.exports.watchUrlChanges = watchUrlChanges;
module.exports.watchForElement = watchForElement;
module.exports.watchDOMChanges = watchDOMChanges;
});


defineModule("utils/eventInterceptor.js", function (module, exports, require) {
/**
 * Reusable event interception utility
 * Provides common patterns for intercepting user actions
 */

// Bare `window` is not reliably the real page window inside a userscript
// sandbox (Firefox in particular gives unqualified `window` a wrapper that
// fails the strict WebIDL check MouseEvent/PointerEvent's `view` field
// requires -- "'view' member of UIEventInit does not implement interface
// Window"). __realWindow is declared once in shim/02-page-inject.js and is
// in lexical scope here since this module is concatenated into that bundle.
function realView() {
  return typeof __realWindow !== "undefined" ? __realWindow : window;
}

/**
 * Stop event propagation and prevent default
 */
function stopEvent(e) {
  e.stopImmediatePropagation();
  e.stopPropagation();
  e.preventDefault();
}

/**
 * Full click event configuration
 */
function fullClickInit() {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: realView(),
  };
}

/**
 * Dispatch a full click sequence (pointerdown, mousedown, mouseup, click)
 */
function dispatchFullClick(target) {
  if (!target) return;

  const init = fullClickInit();
  const events = [
    new PointerEvent("pointerdown", {
      ...init,
      pointerType: "mouse",
    }),
    new MouseEvent("mousedown", init),
    new MouseEvent("mouseup", init),
    new MouseEvent("click", init),
  ];

  events.forEach((evt) => {
    try {
      target.dispatchEvent(evt);
    } catch (_) {
      // Ignore errors
    }
  });
}

/**
 * Dispatch a simple mouse click
 */
function dispatchMouseClick(target) {
  if (!target) return;

  const evt = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: realView(),
  });
  target.dispatchEvent(evt);
}

/**
 * Create an event interceptor for click events
 * @param {Function} matcher - Function that returns true if event should be intercepted
 * @param {Function} handler - Async function that handles the intercepted event
 * @param {Object} options - Options
 * @param {boolean} options.capture - Use capture phase (default: true)
 * @returns {Function} - Cleanup function to remove listener
 */
function interceptClicks(matcher, handler, options = {}) {
  const { capture = true } = options;

  const listener = async (e) => {
    if (e.isTrusted === false) return;

    if (matcher(e)) {
      stopEvent(e);
      const result = await handler(e);
      if (result === false) {
        return false;
      }
    }
  };

  document.addEventListener("click", listener, capture);

  return () => {
    document.removeEventListener("click", listener, capture);
  };
}

/**
 * Create an event interceptor for keyboard events
 * @param {Function} matcher - Function that returns true if event should be intercepted
 * @param {Function} handler - Async function that handles the intercepted event
 * @param {Object} options - Options
 * @param {boolean} options.capture - Use capture phase (default: true)
 * @returns {Function} - Cleanup function to remove listener
 */
function interceptKeydown(matcher, handler, options = {}) {
  const { capture = true } = options;

  const listener = async (e) => {
    if (e.isTrusted === false) return;

    if (matcher(e)) {
      stopEvent(e);
      const result = await handler(e);
      if (result === false) {
        return false;
      }
    }
  };

  document.addEventListener("keydown", listener, capture);

  return () => {
    document.removeEventListener("keydown", listener, capture);
  };
}


module.exports.stopEvent = stopEvent;
module.exports.dispatchFullClick = dispatchFullClick;
module.exports.dispatchMouseClick = dispatchMouseClick;
module.exports.interceptClicks = interceptClicks;
module.exports.interceptKeydown = interceptKeydown;
});


defineModule("ui/toast.js", function (module, exports, require) {
/**
 * Reusable Toast/Tooltip Component
 *
 * Displays temporary messages in the center of the screen.
 * Can be used for notifications, tooltips, and feedback messages.
 */

// A bare checkmark tick (no surrounding circle), stroked with currentColor so it
// inherits the toast's text colour. Pass it as `options.icon` to prefix a
// success toast — e.g. "Saved" downloads.
const CHECK_ICON =
  '<svg aria-label="Done" role="img" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">' +
  '<polyline points="20 6 9 17 4 12"></polyline>' +
  "</svg>";

/**
 * Shows a toast message in the center of the screen
 * @param {string} message - The message to display
 * @param {Object} options - Configuration options
 * @param {number} options.duration - How long to show the toast in ms (default: 2000)
 * @param {string} options.id - Unique ID for the toast (default: 'instafn-toast')
 * @param {string} options.icon - Optional leading SVG markup (e.g. CHECK_ICON)
 */
function showToast(message, options = {}) {
  const { duration = 2000, id = "instafn-toast", icon = null } = options;

  // Remove existing toast with same ID
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  // Inject styles if not already present
  if (!document.getElementById("instafn-toast-styles")) {
    const style = document.createElement("style");
    style.id = "instafn-toast-styles";
    style.textContent = `
      @keyframes instafn-toast-fade-in {
        from {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      }
      @keyframes instafn-toast-fade-out {
        from {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
        to {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.98);
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Create toast element
  const toast = document.createElement("div");
  toast.id = id;
  if (icon) {
    // text + trailing icon on one centred row. The icon markup is a trusted
    // in-extension constant (never user content), so innerHTML is safe here.
    const label = document.createElement("span");
    label.textContent = message;
    const glyph = document.createElement("span");
    glyph.style.display = "inline-flex";
    glyph.innerHTML = icon;
    toast.append(label, glyph);
  } else {
    toast.textContent = message;
  }

  // Apply unified styles
  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    background: "rgba(0, 0, 0, 0.72)",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    zIndex: "999999",
    pointerEvents: "none",
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.35)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    animation: "instafn-toast-fade-in 0.15s ease-out",
  });

  document.body.appendChild(toast);

  // Remove toast after duration
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.transition = "opacity 200ms ease, transform 200ms ease";
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%, -50%) scale(0.96)";
      setTimeout(() => toast.remove(), 220);
    }
  }, duration);
}


module.exports.CHECK_ICON = CHECK_ICON;
module.exports.showToast = showToast;
});


defineModule("ui/modal.js", function (module, exports, require) {
/**
 * Abstract Modal Component
 *
 * Provides two modal variants:
 * 1. Full modal - with tabs support (for follow analyzer, message viewer)
 * 2. Confirm modal - narrow confirmation dialog (for action interceptors)
 */

// Ensure styles are injected
let stylesInjected = false;

function ensureStyles() {
  if (stylesInjected) return;

  const styleId = "instafn-modal-styles";
  if (document.getElementById(styleId)) {
    stylesInjected = true;
    return;
  }

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    .instafn-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .instafn-modal {
      width: min(600px, 90vw);
      max-height: 85vh;
      background: rgb(var(--ig-elevated-background));
      border-radius: var(--igds-dialog-border-radius);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgb(var(--ig-separator));
      animation: instafn-modal-zoom-in 0.1s cubic-bezier(0.08, 0.52, 0.52, 1);
    }

    .instafn-modal.instafn-modal--wide {
      width: min(900px, 95vw);
    }

    @keyframes instafn-modal-zoom-in {
      0% {
        opacity: 0;
        transform: scale(1.2);
      }
      100% {
        opacity: 1;
        transform: scale(1);
      }
    }

    .instafn-modal.instafn-modal--narrow {
      width: min(380px, 92vw);
    }

    .instafn-modal-header {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
      border-bottom: 1px solid rgba(var(--ig-primary-text), 0.1);
      background: rgb(var(--ig-elevated-background));
      position: relative;
    }

    .instafn-header-left {
      display: inline-flex;
      align-items: center;
    }

    .instafn-close {
      position: absolute;
      right: 16px;
      cursor: pointer;
      font-size: 24px;
      line-height: 1;
      border: none;
      background: transparent;
      color: rgb(var(--ig-primary-icon));
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.2s ease;
    }

    .instafn-close:hover {
      color: rgb(var(--ig-secondary-text));
    }

    .instafn-modal-title {
      font-weight: var(--font-weight-system-semibold);
      font-size: var(--system-16-font-size);
      color: rgb(var(--ig-primary-text));
      font-family: var(--font-family-system);
    }

    .instafn-tabs {
      display: flex;
      gap: 0;
      padding: 0;
      border-bottom: 1px solid rgba(var(--ig-primary-text), 0.1);
      background: rgb(var(--ig-elevated-background));
      overflow-x: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      scroll-behavior: smooth;
    }

    .instafn-tabs::-webkit-scrollbar {
      display: none;
    }

    .instafn-tab {
      padding: 16px 20px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: var(--system-14-font-size);
      font-weight: var(--font-weight-system-semibold);
      color: rgb(var(--ig-secondary-text));
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      font-family: var(--font-family-system);
      transition: all 0.2s;
    }

    .instafn-tab.active {
      color: rgb(var(--ig-primary-text));
      border-bottom-color: rgb(var(--ig-primary-text));
    }

    .instafn-tab:hover {
      background: rgb(var(--ig-highlight-background));
    }

    .instafn-content {
      padding: 0;
      overflow: auto;
      max-height: 60vh;
      background: rgb(var(--ig-elevated-background));
    }

    .instafn-modal-description {
      margin: 0 0 16px 0;
      font-size: var(--system-14-font-size);
      color: rgb(var(--ig-secondary-text));
      font-family: var(--font-family-system);
      line-height: 1.4;
    }

    .instafn-button-container {
      display: flex !important;
      gap: 12px !important;
      justify-content: center !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      margin-top: 20px !important;
    }

    .instafn-primary-button {
      background: rgb(var(--ig-colors-button-primary-background));
      color: rgb(var(--ig-colors-button-primary-text));
      border: none;
      border-radius: 8px;
      padding: 12px 24px;
      font-weight: var(--font-weight-system-semibold);
      font-size: var(--system-14-font-size);
      cursor: pointer;
      font-family: var(--font-family-system);
      transition: background-color 0.2s;
    }

    .instafn-primary-button:hover {
      background: rgb(var(--ig-colors-button-primary-background--hover));
    }

    .instafn-primary-button:active {
      background: rgb(var(--ig-colors-button-primary-background--pressed));
    }

    .instafn-primary-button:disabled {
      background: rgb(var(--ig-colors-button-primary-background--disabled));
      color: rgb(var(--ig-colors-button-primary-text--disabled));
    }

    .instafn-secondary-button {
      background: rgb(var(--ig-secondary-button-background));
      color: rgb(var(--ig-secondary-button));
      border: none;
      border-radius: 8px;
      padding: 12px 24px;
      font-weight: var(--font-weight-system-semibold);
      font-size: var(--system-14-font-size);
      cursor: pointer;
      font-family: var(--font-family-system);
      transition: background-color 0.2s;
    }

    .instafn-secondary-button:hover {
      background: rgba(var(--ig-primary-text), 0.1);
    }

    .instafn-list {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .instafn-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(var(--ig-primary-text), 0.1);
      transition: background-color 0.2s;
    }

    .instafn-item:hover {
      background: rgb(var(--ig-highlight-background));
    }

    .instafn-item-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
    }

    .instafn-item img {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      background: rgb(var(--ig-secondary-background));
    }

    .instafn-item-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .instafn-item-username {
      font-weight: var(--font-weight-system-semibold);
      font-size: var(--system-14-font-size);
      color: rgb(var(--ig-primary-text));
      font-family: var(--font-family-system);
    }

    .instafn-item-name {
      font-size: var(--system-14-font-size);
      color: rgb(var(--ig-secondary-text));
      font-family: var(--font-family-system);
    }

    .instafn-item a {
      color: inherit;
      text-decoration: none;
    }

    .instafn-item a:hover {
      text-decoration: underline;
    }

    .instafn-item-username a {
      color: rgb(var(--ig-primary-text)) !important;
    }

    .instafn-follow-btn {
      background: rgb(var(--ig-colors-button-primary-background));
      color: rgb(var(--ig-colors-button-primary-text));
      border: none;
      border-radius: 8px;
      padding: 7px 16px;
      font-weight: var(--font-weight-system-semibold);
      font-size: var(--system-14-font-size);
      cursor: pointer;
      font-family: var(--font-family-system);
      transition: background-color 0.2s;
    }

    .instafn-follow-btn:hover {
      background: rgb(var(--ig-colors-button-primary-background--hover));
    }

    .instafn-follow-btn:active {
      background: rgb(var(--ig-colors-button-primary-background--pressed));
    }

    .instafn-follow-btn:disabled {
      background: rgb(var(--ig-colors-button-primary-background--disabled));
      color: rgb(var(--ig-colors-button-primary-text--disabled));
    }

    .instafn-follow-btn.following {
      background: rgb(var(--ig-secondary-button-background));
      color: rgb(var(--ig-secondary-button));
    }

    .instafn-follow-btn.following:hover {
      background: rgba(var(--ig-primary-text), 0.1);
    }

    .instafn-empty {
      color: rgb(var(--ig-secondary-text));
      font-style: italic;
      text-align: center;
      padding: 40px 20px;
      font-size: var(--system-14-font-size);
      font-family: var(--font-family-system);
    }

    .instafn-warning-box {
      margin-bottom: 20px;
      padding: 12px;
      background: rgb(var(--ig-temporary-highlight));
      border: 1px solid rgb(var(--ig-separator));
      border-radius: 8px;
      color: rgb(var(--ig-secondary-text));
      font-size: var(--system-13-font-size);
      font-family: var(--font-family-system);
      line-height: 1.4;
    }

    .instafn-loading-text {
      margin: 0;
      font-size: var(--system-14-font-size);
      color: rgb(var(--ig-secondary-text));
      font-family: var(--font-family-system);
    }

    .instafn-error-icon {
      margin-bottom: 20px;
      color: rgb(var(--ig-error-or-destructive));
      font-size: 48px;
    }

    .instafn-error-title {
      margin: 0 0 12px 0;
      font-size: var(--system-18-font-size);
      font-weight: var(--font-weight-system-semibold);
      color: rgb(var(--ig-primary-text));
      font-family: var(--font-family-system);
    }

    .instafn-error-message {
      margin: 0 0 24px 0;
      font-size: var(--system-14-font-size);
      color: rgb(var(--ig-secondary-text));
      font-family: var(--font-family-system);
      line-height: 1.4;
    }

    .instafn-loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 40px 20px;
    }

    .instafn-loading-spinner {
      width: 32px;
      height: 32px;
      margin: 0 auto 20px;
      border: 3px solid rgb(var(--ig-separator));
      border-top-color: rgb(var(--ig-primary-text));
      border-radius: 50%;
      animation: instafn-spin 0.8s linear infinite;
    }

    @keyframes instafn-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  document.head.appendChild(style);
  stylesInjected = true;
}

/**
 * Creates a full modal with tabs support (variant 1)
 * @param {string} titleText - Modal title
 * @param {Object} options - Options
 * @param {boolean} options.showTabs - Whether to show tabs (default: true)
 * @param {boolean} options.closeOnBackdrop - Dismiss when the backdrop is clicked (default: true)
 * @param {boolean} options.closeOnEscape - Dismiss when Escape is pressed (default: true)
 * @returns {Promise<HTMLElement>} - The overlay element containing the modal
 */
async function createModal(titleText, options = {}) {
  ensureStyles();

  const {
    showTabs = true,
    closeOnBackdrop = true,
    closeOnEscape = true,
  } = options;

  const overlay = document.createElement("div");
  overlay.className = "instafn-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "instafn-modal";

  const header = document.createElement("div");
  header.className = "instafn-modal-header";

  const headerLeft = document.createElement("div");
  headerLeft.className = "instafn-header-left";

  const title = document.createElement("div");
  title.className = "instafn-modal-title";
  title.textContent = titleText || "";
  headerLeft.appendChild(title);

  const close = document.createElement("button");
  close.className = "instafn-close";
  close.innerHTML = `<svg aria-label="Close" class="x1lliihq x1n2onr6 x5n08af" fill="currentColor" height="24" role="img" viewBox="0 0 24 24" width="24">
    <title>Close</title>
    <line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="21" x2="3" y1="3" y2="21"></line>
    <line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="21" x2="3" y1="21" y2="3"></line>
  </svg>`;
  close.addEventListener("click", () => {
    overlay.remove();
  });

  header.appendChild(headerLeft);
  header.appendChild(close);

  const tabs = document.createElement("div");
  tabs.className = "instafn-tabs";
  if (!showTabs) {
    tabs.style.display = "none";
  }

  const content = document.createElement("div");
  content.className = "instafn-content";

  modal.appendChild(header);
  modal.appendChild(tabs);
  modal.appendChild(content);
  overlay.appendChild(modal);

  // Close on backdrop click
  if (closeOnBackdrop) {
    const backdropClickHandler = (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    };
    overlay.addEventListener("click", backdropClickHandler);
    overlay._clickHandler = backdropClickHandler;
  }

  // Close on Escape key
  if (closeOnEscape) {
    const handleEscape = (e) => {
      if (e.key === "Escape" && document.body.contains(overlay)) {
        document.removeEventListener("keydown", handleEscape, true);
        overlay.remove();
      }
    };
    document.addEventListener("keydown", handleEscape, true);
  }

  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Creates a confirmation modal (variant 2 - narrow)
 * @param {Object} options - Options
 * @param {string} options.title - Modal title (default: "Confirm")
 * @param {string} options.message - Message text (default: "Are you sure?")
 * @param {string} options.confirmText - Confirm button text (default: "Confirm")
 * @param {string} options.cancelText - Cancel button text (default: "Cancel")
 * @returns {Promise<boolean>} - Resolves to true if confirmed, false if cancelled
 */
function confirmModal({
  title = "Confirm",
  message = "Are you sure?",
  confirmText = "Confirm",
  cancelText = "Cancel",
} = {}) {
  ensureStyles();

  return new Promise(async (resolve) => {
    try {
      const overlay = await createModal(title, { showTabs: false });
      const modal = overlay.querySelector(".instafn-modal");
      modal.classList.add("instafn-modal--narrow");
      const content = overlay.querySelector(".instafn-content");

      content.innerHTML = `
        <div style="text-align: center; padding: 20px 20px 28px 20px;">
          <p class="instafn-modal-description">${message}</p>
          <div class="instafn-button-container">
            <button class="instafn-secondary-button" data-instafn-cancel>${cancelText}</button>
            <button class="instafn-primary-button" data-instafn-confirm>${confirmText}</button>
          </div>
        </div>
      `;

      const cleanupAndResolve = (value) => {
        if (document.body.contains(overlay)) {
          overlay.remove();
        }
        resolve(value);
      };

      content
        .querySelector("[data-instafn-cancel]")
        .addEventListener("click", () => cleanupAndResolve(false));
      content
        .querySelector("[data-instafn-confirm]")
        .addEventListener("click", () => cleanupAndResolve(true));

      const closeBtn = modal.querySelector(".instafn-close");
      if (closeBtn) {
        closeBtn.onclick = () => cleanupAndResolve(false);
      }

      // The overlay click handler is already set up in createModal
      // We just need to override it for this specific case
      const originalClickHandler = overlay._clickHandler;
      if (originalClickHandler) {
        overlay.removeEventListener("click", originalClickHandler);
      }
      overlay._clickHandler = (e) => {
        if (e.target === overlay) {
          cleanupAndResolve(false);
        }
      };
      overlay.addEventListener("click", overlay._clickHandler);
    } catch (err) {
      // Fallback to native confirm
      resolve(confirm(message));
    }
  });
}


module.exports.createModal = createModal;
module.exports.confirmModal = confirmModal;
});


// ---- boot ----

try {
  initSettingsPageEntryPoints();
} catch (err) {
  console.error("[Instafn] fatal error setting up the settings panel:", err);
}
try {
  require("content.js");
} catch (err) {
  console.error("[Instafn] fatal error during startup:", err);
}
