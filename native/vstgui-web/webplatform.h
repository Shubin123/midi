// The C side of VSTGUI's web platform (webplatform.cpp): what vst3web.cpp calls to drive an open editor's frame
// from the browser, and the JavaScript functions (module "vstgui", js/vstgui-web.js) the platform draws and
// asks the page with. One editor frame per module instance: the page runs a separate instance for each editor.

#pragma once

#define VSTGUI_WEB_IMPORT(name) __attribute__ ((import_module ("vstgui"), import_name (#name)))

extern "C" {

// Drawing. begin(target) selects the editor's canvas (0) or an offscreen bitmap; clip and transform are in the
// editor's points, which the page scales to device pixels.
VSTGUI_WEB_IMPORT (begin) void vstgui_web_js_begin (int target, double scale);
VSTGUI_WEB_IMPORT (end) void vstgui_web_js_end ();
VSTGUI_WEB_IMPORT (save) void vstgui_web_js_save ();
VSTGUI_WEB_IMPORT (restore) void vstgui_web_js_restore ();
VSTGUI_WEB_IMPORT (clip) void vstgui_web_js_clip (double x, double y, double w, double h);
VSTGUI_WEB_IMPORT (transform) void vstgui_web_js_transform (double a, double b, double c, double d, double e, double f);
VSTGUI_WEB_IMPORT (alpha) void vstgui_web_js_alpha (double alpha);
VSTGUI_WEB_IMPORT (fill_color) void vstgui_web_js_fill_color (double r, double g, double b, double a);
VSTGUI_WEB_IMPORT (stroke_color) void vstgui_web_js_stroke_color (double r, double g, double b, double a);
VSTGUI_WEB_IMPORT (line_style) void vstgui_web_js_line_style (double width, int cap, int join, const double* dash, int dashCount, double phase);
// A path as opcodes (see PathOp in webplatform.cpp), made the current path.
VSTGUI_WEB_IMPORT (path) void vstgui_web_js_path (const double* ops, int count);
VSTGUI_WEB_IMPORT (fill) void vstgui_web_js_fill (int evenOdd);
VSTGUI_WEB_IMPORT (stroke) void vstgui_web_js_stroke ();
VSTGUI_WEB_IMPORT (hit) int vstgui_web_js_hit (const double* ops, int count, double x, double y, int evenOdd);
// A gradient as the fill: stops are (offset, r, g, b, a) quintuples, 0..1.
VSTGUI_WEB_IMPORT (gradient) void vstgui_web_js_gradient (int radial, double x0, double y0, double r0, double x1, double y1, double r1, const double* stops, int count);
VSTGUI_WEB_IMPORT (clear) void vstgui_web_js_clear (double x, double y, double w, double h);
VSTGUI_WEB_IMPORT (image) void vstgui_web_js_image (int id, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh, double alpha, int smooth);
VSTGUI_WEB_IMPORT (pattern) void vstgui_web_js_pattern (int id, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh);

// Text, in the font last set: metrics out = ascent, descent, leading, cap height.
VSTGUI_WEB_IMPORT (font) void vstgui_web_js_font (const char* family, double size, int style);
VSTGUI_WEB_IMPORT (font_metrics) void vstgui_web_js_font_metrics (double* out);
VSTGUI_WEB_IMPORT (text_width) double vstgui_web_js_text_width (const char* text);
VSTGUI_WEB_IMPORT (text) void vstgui_web_js_text (const char* text, double x, double y, int style);

// Bitmaps: the page holds them, by id. A bitmap is loaded by the name the editor asks for, from the files in the
// bundle's Contents/Resources the page has read beforehand; size out = width, height in pixels.
VSTGUI_WEB_IMPORT (bitmap_new) int vstgui_web_js_bitmap_new (int w, int h);
VSTGUI_WEB_IMPORT (bitmap_load) int vstgui_web_js_bitmap_load (const char* name, int* size);
VSTGUI_WEB_IMPORT (bitmap_free) void vstgui_web_js_bitmap_free (int id);
VSTGUI_WEB_IMPORT (bitmap_read) void vstgui_web_js_bitmap_read (int id, unsigned char* rgba, int premultiplied);
VSTGUI_WEB_IMPORT (bitmap_write) void vstgui_web_js_bitmap_write (int id, const unsigned char* rgba, int premultiplied);

// Files in Contents/Resources (the .uidesc): size, or -1 when there is none, and its bytes.
VSTGUI_WEB_IMPORT (resource_size) int vstgui_web_js_resource_size (const char* name);
VSTGUI_WEB_IMPORT (resource_read) void vstgui_web_js_resource_read (const char* name, void* to);

// The frame asks the page: redraw soon, show a cursor or a tooltip, run a timer, copy text.
VSTGUI_WEB_IMPORT (invalidate) void vstgui_web_js_invalidate ();
VSTGUI_WEB_IMPORT (cursor) void vstgui_web_js_cursor (int type);
VSTGUI_WEB_IMPORT (tooltip) void vstgui_web_js_tooltip (const char* text);
VSTGUI_WEB_IMPORT (timer_start) void vstgui_web_js_timer_start (int id, int ms);
VSTGUI_WEB_IMPORT (timer_stop) void vstgui_web_js_timer_stop (int id);
VSTGUI_WEB_IMPORT (clipboard) void vstgui_web_js_clipboard (const char* text);

// What vst3web.cpp calls. draw() runs pending tasks and draws what was invalidated, returning 1 if it drew.
// Mouse types: 0 down, 1 move, 2 up, 3 exit. Buttons: 1 left, 2 right, 4 middle. Modifiers: 1 shift, 2 alt,
// 4 control, 8 super. Keys: virt is VSTGUI's VirtualKey, character a UTF-32 code point; returns 1 if consumed.
int vstgui_web_draw (double scale);
void vstgui_web_mouse (int type, double x, double y, int buttons, int modifiers, int clicks);
void vstgui_web_wheel (double x, double y, double dx, double dy, int modifiers);
int vstgui_web_key (int down, int virt, unsigned character, int modifiers, int repeat);
void vstgui_web_timer (int id);
void vstgui_web_focus (int on);

} // extern "C"
