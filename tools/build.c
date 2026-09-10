#include "build.h"
#include <mujs.h>

#define NAME        "Instafn"
#define NAMESPACE   "https://github.com/xafn/instafn"
#define VERSION     "4.0.0"
#define DESCRIPTION "Instagram privacy/productivity mods (userscript port of the Instafn extension)"
#define AUTHOR      "afn (original extension); userscript port via HimadriChakra12"

static void jsb_readFile(js_State *J) {
    const char *path = js_tostring(J, 1);
    long len;
    char *data = build_read_file(path, &len);
    js_pushstring(J, data);
    free(data);
}

static void jsb_writeFile(js_State *J) {
    const char *path = js_tostring(J, 1);
    const char *data = js_tostring(J, 2);
    /* transform.js only ever writes into build/, which build.c below has
     * already created, but mkdir_p again here costs nothing and makes this
     * function safe to call with any path. */
    char dir[4096];
    snprintf(dir, sizeof(dir), "%s", path);
    char *slash = strrchr(dir, '/');
    if (slash) { *slash = '\0'; build_mkdir_p(dir); }
    build_write_file(path, data);
    js_pushundefined(J);
}

static void jsb_exists(js_State *J) {
    const char *path = js_tostring(J, 1);
    struct stat st;
    js_pushboolean(J, stat(path, &st) == 0);
}

static void jsb_log(js_State *J) {
    int i, top = js_gettop(J);
    for (i = 1; i < top; i++) {
        if (i > 1) fputc(' ', stderr);
        fputs(js_tostring(J, i), stderr);
    }
    fputc('\n', stderr);
    js_pushundefined(J);
}

static void run_transform(const char *script_path) {
    js_State *J = js_newstate(NULL, NULL, JS_STRICT);
    if (!J) { fprintf(stderr, "build: could not create MuJS state\n"); exit(1); }

    js_newcfunction(J, jsb_readFile, "readFile", 1);
    js_setglobal(J, "readFile");
    js_newcfunction(J, jsb_writeFile, "writeFile", 2);
    js_setglobal(J, "writeFile");
    js_newcfunction(J, jsb_exists, "exists", 1);
    js_setglobal(J, "exists");
    js_newcfunction(J, jsb_log, "log", 0);
    js_setglobal(J, "log");

    if (js_dofile(J, script_path)) {
        fprintf(stderr, "build: %s\n", js_trystring(J, -1, "error"));
        js_freestate(J);
        exit(1);
    }
    js_freestate(J);
}

LISTOF(MATCH,
    "*://www.instagram.com/*"
);

LISTOF(CONNECT,
    "cdninstagram.com",
    "fbcdn.net",
    "fbsbx.com"
);

/* GM_addValueChangeListener isn't used yet (same-tab onChanged is handled
 * without it -- see chrome-shim.js) but is granted so a future cross-tab
 * sync pass doesn't need a build change. */
LISTOF(GRANT,
    "GM_getValue",
    "GM_setValue",
    "GM_addValueChangeListener",
    "GM_registerMenuCommand",
    "GM_addStyle",
    "GM_xmlhttpRequest",
    "GM_download",
    "GM_info",
    "unsafeWindow"
);

#define VENDOR_ROOT "vendor/instafn/content"
#define BUILD_DIR   "build"
#define MANIFEST    BUILD_DIR "/manifest.txt"
#define BUNDLE      BUILD_DIR "/bundle.js"
#define OUT_PATH    "dist/instafnscript.user.js"

int main(int argc, char **argv) {
    const char *script_path = (argc > 1) ? argv[1] : "tools/transform.js";

    build_mkdir_p(BUILD_DIR);
    build_mkdir_p("dist");

    /* 1. Walk the vendored source tree, write the manifest transform.js
     *    reads (MuJS's host has no readdir on purpose -- see avroc.c). */
    strlist_t files;
    strlist_init(&files);
    walk_js_files(VENDOR_ROOT, "", &files);

    size_t manifestCap = 65536, manifestLen = 0;
    char *manifest = malloc(manifestCap);
    manifest[0] = '\0';
    for (size_t i = 0; i < files.count; i++) {
        size_t need = manifestLen + strlen(files.items[i]) + 2;
        if (need > manifestCap) { manifestCap = need * 2; manifest = realloc(manifest, manifestCap); }
        manifestLen += (size_t)snprintf(manifest + manifestLen, manifestCap - manifestLen, "%s\n", files.items[i]);
    }
    build_write_file(MANIFEST, manifest);
    fprintf(stderr, "build: found %zu vendored .js files\n", files.count);
    free(manifest);
    strlist_free(&files);

    /* 2. Hand off to MuJS: strips import/export, wraps every vendored file
     *    as a CommonJS-lite module, pastes in the shim chunks + embedded
     *    CSS + page scripts, writes build/bundle.js. */
    run_transform(script_path);

    /* 3. Wrap the bundle in the userscript header + one top-level IIFE
     *    (same reasoning as Avroscript's build.js: every chunk declares
     *    shared state with `var`, so one closure keeps all of it off
     *    window -- confirmed nothing this project defines needs to be
     *    visible outside the script itself, since the settings panel and
     *    the chrome shim only ever get called via the userscript's own
     *    entry points). */
    userscript_meta_t meta = {
        .name = NAME, .namespace_ = NAMESPACE, .version = VERSION,
        .description = DESCRIPTION, .author = AUTHOR,
        .match = MATCH, .match_count = MATCH_COUNT,
        .connect = CONNECT, .connect_count = CONNECT_COUNT,
        .grant = GRANT, .grant_count = GRANT_COUNT,
        .run_at = "document-start",
    };
    char *header = build_userscript_header(&meta);

    long bundleLen;
    char *bundle = build_read_file(BUNDLE, &bundleLen);

    size_t outCap = strlen(header) + (size_t)bundleLen + 256;
    char *out = malloc(outCap);
    int n = snprintf(out, outCap, "%s\n(function () {\n\"use strict\";\n\n%s\n\n})();\n", header, bundle);

    build_write_file(OUT_PATH, out);
    fprintf(stderr, "build: wrote %s (%d bytes)\n", OUT_PATH, n);

    free(header);
    free(bundle);
    free(out);
    return 0;
}
