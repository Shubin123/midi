// VSTGUI's platform layer for the browser. VSTGUI has backends for macOS (Quartz), Windows (Direct2D) and
// Linux (X11 or Wayland, drawing with Cairo); this is one more, for a VST3 plug-in compiled to WebAssembly
// with vst3web. It draws with the page's Canvas 2D through the functions in webplatform.h: every draw call
// becomes one or two calls on the canvas, with VSTGUI's own state (clip, transform, colours, line style)
// kept here and set on the canvas around each one, as the Cairo backend does around each Cairo call. Canvas 2D
// rather than Cairo compiled for WebAssembly: Cairo would bring pixman, FreeType, fontconfig and Pango (several
// MB, and fonts to ship), where the browser already draws antialiased paths, gradients, images and text.
//
// The rest: bitmaps live in the page (decoded by the browser from the PNGs in the bundle's Contents/Resources,
// read before the editor opens), fonts are the browser's, timers are the page's setInterval, text edits and
// option menus are VSTGUI's own generic ones (drawn by VSTGUI, typed into from the page's key events), tasks run
// on the page's thread when the frame next draws, and the clipboard takes text.
//
// The SDK and VSTGUI are compiled as for Linux (Emscripten's libc is close enough to Linux's), so VST3Editor
// keeps its Linux code; this factory takes the place of the X11 one and ignores the X11 frame configuration
// it is handed. Uses VSTGUI (BSD 3-Clause License, LICENSES/VSTGUI.txt).

#include "webplatform.h"

#include "vstgui/lib/cbitmap.h"
#include "vstgui/lib/ccolor.h"
#include "vstgui/lib/cdrawdefs.h"
#include "vstgui/lib/cframe.h"
#include "vstgui/lib/cgraphicstransform.h"
#include "vstgui/lib/clinestyle.h"
#include "vstgui/lib/cresourcedescription.h"
#include "vstgui/lib/cstring.h"
#include "vstgui/lib/events.h"
#include "vstgui/lib/platform/common/generictextedit.h"
#include "vstgui/lib/platform/common/genericoptionmenu.h"
#include "vstgui/lib/platform/common/gradientbase.h"
#include "vstgui/lib/platform/iplatformbitmap.h"
#include "vstgui/lib/platform/iplatformfont.h"
#include "vstgui/lib/platform/iplatformframe.h"
#include "vstgui/lib/platform/iplatformframecallback.h"
#include "vstgui/lib/platform/iplatformgraphicsdevice.h"
#include "vstgui/lib/platform/iplatformgraphicspath.h"
#include "vstgui/lib/platform/iplatformopenglview.h"
#include "vstgui/lib/platform/iplatformviewlayer.h"
#include "vstgui/lib/platform/iplatformresourceinputstream.h"
#include "vstgui/lib/platform/iplatformstring.h"
#include "vstgui/lib/platform/iplatformtaskexecutor.h"
#include "vstgui/lib/platform/iplatformtimer.h"
#include "vstgui/lib/platform/platformfactory.h"

#include "pluginterfaces/base/funknown.h"

#include <chrono>
#include <cmath>
#include <deque>
#include <map>
#include <stack>
#include <string>
#include <vector>

namespace VSTGUI {

using TransformMatrix = CGraphicsTransform;

/* ---- Strings ---- */

class WebString : public IPlatformString
{
public:
	explicit WebString (UTF8StringPtr s = nullptr) { setUTF8String (s); }
	void setUTF8String (UTF8StringPtr s) override { str = s ? s : ""; }
	const std::string& get () const { return str; }

private:
	std::string str;
};

/* ---- Bitmaps ---- */

class WebPixelAccess : public IPlatformBitmapPixelAccess
{
public:
	WebPixelAccess (int id, CPoint size, bool premultiplied)
	: id (id), width (static_cast<uint32_t> (size.x)), premultiplied (premultiplied),
	  pixels (static_cast<size_t> (size.x * size.y * 4))
	{
		vstgui_web_js_bitmap_read (id, pixels.data (), premultiplied);
	}
	~WebPixelAccess () noexcept override { vstgui_web_js_bitmap_write (id, pixels.data (), premultiplied); }
	uint8_t* getAddress () const override { return const_cast<uint8_t*> (pixels.data ()); }
	uint32_t getBytesPerRow () const override { return width * 4; }
	PixelFormat getPixelFormat () const override { return kRGBA; }

private:
	int id;
	uint32_t width;
	bool premultiplied;
	std::vector<uint8_t> pixels;
};

class WebBitmap : public IPlatformBitmap
{
public:
	WebBitmap (int id, CPoint size) : id (id), size (size) {}
	~WebBitmap () noexcept override { vstgui_web_js_bitmap_free (id); }
	const CPoint& getSize () const override { return size; }
	SharedPointer<IPlatformBitmapPixelAccess> lockPixels (bool alphaPremultiplied) override
	{
		return makeOwned<WebPixelAccess> (id, size, alphaPremultiplied);
	}
	void setScaleFactor (double factor) override { scaleFactor = factor; }
	double getScaleFactor () const override { return scaleFactor; }
	int getId () const { return id; }

private:
	int id;
	CPoint size; // in pixels
	double scaleFactor {1.};
};

/* ---- Paths and gradients ---- */

// Path opcodes, as the page reads them (js/vstgui-web.js): each is followed by its numbers.
enum PathOp
{
	kMove = 0,    // x y
	kLine = 1,    // x y
	kBezier = 2,  // c1x c1y c2x c2y x y
	kEllipse = 3, // cx cy rx ry start end anticlockwise
	kRect = 4,    // x y w h
	kClose = 5,
};

class WebPath : public IPlatformGraphicsPath
{
public:
	explicit WebPath (PlatformGraphicsPathFillMode mode) : mode (mode) {}
	void addArc (const CRect& rect, double startAngle, double endAngle, bool clockwise) override
	{
		auto rx = rect.getWidth () / 2., ry = rect.getHeight () / 2.;
		auto start = radians (startAngle), end = radians (endAngle);
		if (rx != ry) // from an angle round the ellipse to the parameter that reaches it, as Cairo's backend does
		{
			start = std::atan2 (std::sin (start) * rx, std::cos (start) * ry);
			end = std::atan2 (std::sin (end) * rx, std::cos (end) * ry);
		}
		push ({kEllipse, rect.left + rx, rect.top + ry, rx, ry, start, end, clockwise ? 0. : 1.});
		grow (rect.getTopLeft ());
		grow (rect.getBottomRight ());
	}
	void addEllipse (const CRect& rect) override { addArc (rect, 0, 360, true); }
	void addRect (const CRect& rect) override
	{
		push ({kRect, rect.left, rect.top, rect.getWidth (), rect.getHeight ()});
		grow (rect.getTopLeft ());
		grow (rect.getBottomRight ());
	}
	void addLine (const CPoint& to) override { push ({kLine, to.x, to.y}); grow (to); }
	void addBezierCurve (const CPoint& c1, const CPoint& c2, const CPoint& end) override
	{
		push ({kBezier, c1.x, c1.y, c2.x, c2.y, end.x, end.y});
		grow (c1); grow (c2); grow (end);
	}
	void beginSubpath (const CPoint& start) override { push ({kMove, start.x, start.y}); grow (start); }
	void closeSubpath () override { push ({kClose}); }
	void finishBuilding () override {}
	bool hitTest (const CPoint& p, bool evenOddFilled, CGraphicsTransform* transform) const override
	{
		auto q = p;
		if (transform)
			transform->inverse ().transform (q);
		return vstgui_web_js_hit (ops.data (), static_cast<int> (ops.size ()), q.x, q.y, evenOddFilled) != 0;
	}
	CRect getBoundingBox () const override { return empty ? CRect () : bounds; }
	PlatformGraphicsPathFillMode getFillMode () const override { return mode; }

	const std::vector<double>& get () const { return ops; }
	// The same path with every point moved, for drawing it pixel-aligned.
	std::vector<double> mapped (const std::function<CPoint (CPoint)>& f) const
	{
		auto out = ops;
		for (size_t i = 0; i < out.size ();)
		{
			auto op = static_cast<int> (out[i]);
			auto points = op == kMove || op == kLine ? 1 : op == kBezier ? 3 : op == kRect || op == kEllipse ? 1 : 0;
			for (int k = 0; k < points; ++k)
			{
				auto q = f (CPoint (out[i + 1 + k * 2], out[i + 2 + k * 2]));
				out[i + 1 + k * 2] = q.x;
				out[i + 2 + k * 2] = q.y;
			}
			i += 1 + (op == kMove || op == kLine ? 2 : op == kBezier ? 6 : op == kEllipse ? 7 : op == kRect ? 4 : 0);
		}
		return out;
	}

private:
	void push (std::initializer_list<double> values) { ops.insert (ops.end (), values); }
	void grow (CPoint p)
	{
		if (empty) { bounds = CRect (p, CPoint ()); empty = false; return; }
		bounds.left = std::min (bounds.left, p.x); bounds.top = std::min (bounds.top, p.y);
		bounds.right = std::max (bounds.right, p.x); bounds.bottom = std::max (bounds.bottom, p.y);
	}
	PlatformGraphicsPathFillMode mode;
	std::vector<double> ops;
	CRect bounds;
	bool empty {true};
};

class WebPathFactory : public IPlatformGraphicsPathFactory
{
public:
	PlatformGraphicsPathPtr createPath (PlatformGraphicsPathFillMode fillMode) override
	{
		return std::make_unique<WebPath> (fillMode);
	}
	// Text as outlines isn't something the canvas gives: VSTGUI draws such text as text instead.
	PlatformGraphicsPathPtr createTextPath (const PlatformFontPtr&, UTF8StringPtr) override { return nullptr; }
};

class WebGradient : public PlatformGradientBase
{
public:
	std::vector<double> stops () const
	{
		std::vector<double> out;
		for (auto& [offset, c] : getColorStops ())
			out.insert (out.end (), {offset, c.normRed<double> (), c.normGreen<double> (), c.normBlue<double> (), c.normAlpha<double> ()});
		return out;
	}
};

/* ---- The drawing context ---- */

class WebGraphicsDevice;

class WebGraphicsContext : public IPlatformGraphicsDeviceContext
{
public:
	WebGraphicsContext (const WebGraphicsDevice& device, int target, double scale)
	: device (device), target (target), scale (scale) {}

	const IPlatformGraphicsDevice& getDevice () const override;
	PlatformGraphicsPathFactoryPtr getGraphicsPathFactory () const override
	{
		static auto factory = std::make_shared<WebPathFactory> ();
		return factory;
	}
	bool beginDraw () const override { vstgui_web_js_begin (target, scale); return true; }
	bool endDraw () const override { vstgui_web_js_end (); return true; }

	bool drawLine (LinePair line) const override
	{
		return drawLines ({line});
	}
	bool drawLines (const LineList& lines) const override
	{
		inContext ([&] () {
			applyLineStyle ();
			auto t = lineTranslate ();
			std::vector<double> ops;
			for (auto& [a, b] : lines)
			{
				auto s = integral () ? align (a) : a, e = integral () ? align (b) : b;
				ops.insert (ops.end (), {kMove, s.x + t, s.y + t, kLine, e.x + t, e.y + t});
			}
			vstgui_web_js_path (ops.data (), static_cast<int> (ops.size ()));
			vstgui_web_js_stroke ();
		});
		return true;
	}
	bool drawPolygon (const PointList& points, PlatformGraphicsDrawStyle style) const override
	{
		if (points.empty ())
			return false;
		inContext ([&] () {
			std::vector<double> ops;
			for (size_t i = 0; i < points.size (); ++i)
			{
				auto p = integral () ? align (points[i]) : points[i];
				ops.insert (ops.end (), {i ? double (kLine) : double (kMove), p.x, p.y});
			}
			ops.push_back (kClose);
			vstgui_web_js_path (ops.data (), static_cast<int> (ops.size ()));
			draw (style);
		});
		return true;
	}
	bool drawRect (CRect rect, PlatformGraphicsDrawStyle style) const override
	{
		inContext ([&] () {
			// As the Cairo backend: a stroked rect's edge runs along the inside of its bounds.
			if (style != PlatformGraphicsDrawStyle::Filled)
			{
				rect.right -= 1.;
				rect.bottom -= 1.;
			}
			double ops[5];
			if (integral ())
			{
				rect = align (rect);
				auto t = style != PlatformGraphicsDrawStyle::Filled ? lineTranslate () : 0.;
				double r[] = {kRect, rect.left + t, rect.top + t, rect.getWidth (), rect.getHeight ()};
				std::copy (r, r + 5, ops);
			}
			else
			{
				double r[] = {kRect, rect.left + 0.5, rect.top + 0.5, rect.getWidth () - 0.5, rect.getHeight () - 0.5};
				std::copy (r, r + 5, ops);
			}
			vstgui_web_js_path (ops, 5);
			draw (style);
		});
		return true;
	}
	bool drawArc (CRect rect, double startAngle, double endAngle, PlatformGraphicsDrawStyle style) const override
	{
		WebPath path (PlatformGraphicsPathFillMode::Winding);
		if (integral ())
			rect = align (rect);
		path.addArc (rect, startAngle, endAngle, true);
		inContext ([&] () {
			vstgui_web_js_path (path.get ().data (), static_cast<int> (path.get ().size ()));
			draw (style);
		});
		return true;
	}
	bool drawEllipse (CRect rect, PlatformGraphicsDrawStyle style) const override
	{
		return drawArc (rect, 0, 360, style);
	}
	bool drawPoint (CPoint point, CColor color) const override
	{
		inContext ([&] () {
			vstgui_web_js_fill_color (color.normRed<double> (), color.normGreen<double> (), color.normBlue<double> (), color.normAlpha<double> () * state.alpha);
			double ops[] = {kRect, point.x, point.y, 1, 1};
			vstgui_web_js_path (ops, 5);
			vstgui_web_js_fill (0);
		});
		return true;
	}
	bool drawBitmap (IPlatformBitmap& bitmap, CRect dest, CPoint offset, double alpha, BitmapInterpolationQuality quality) const override
	{
		auto web = dynamic_cast<WebBitmap*> (&bitmap);
		if (!web)
			return false;
		inContext ([&] () {
			// The part of the bitmap from `offset`, as big as dest, in its pixels (a 2x bitmap has twice as many).
			auto s = web->getScaleFactor ();
			vstgui_web_js_image (web->getId (), offset.x * s, offset.y * s, dest.getWidth () * s, dest.getHeight () * s,
			                     dest.left, dest.top, dest.getWidth (), dest.getHeight (), alpha * state.alpha,
			                     quality != BitmapInterpolationQuality::kLow);
		});
		return true;
	}
	bool clearRect (CRect rect) const override
	{
		inContext ([&] () { vstgui_web_js_clear (rect.left, rect.top, rect.getWidth (), rect.getHeight ()); });
		return true;
	}
	bool drawGraphicsPath (IPlatformGraphicsPath& path, PlatformGraphicsPathDrawMode mode, TransformMatrix* tm) const override
	{
		auto web = dynamic_cast<WebPath*> (&path);
		if (!web)
			return false;
		inContext ([&] () {
			usePath (*web, tm);
			if (mode == PlatformGraphicsPathDrawMode::Stroked)
			{
				applyLineStyle ();
				vstgui_web_js_stroke ();
			}
			else
			{
				applyFill ();
				vstgui_web_js_fill (mode == PlatformGraphicsPathDrawMode::FilledEvenOdd);
			}
		});
		return true;
	}
	bool fillLinearGradient (IPlatformGraphicsPath& path, const IPlatformGradient& gradient, CPoint start, CPoint end,
	                         bool evenOdd, TransformMatrix* tm) const override
	{
		return fillGradient (path, gradient, false, start, 0, end, 0, evenOdd, tm);
	}
	bool fillRadialGradient (IPlatformGraphicsPath& path, const IPlatformGradient& gradient, CPoint center, CCoord radius,
	                         CPoint originOffset, bool evenOdd, TransformMatrix* tm) const override
	{
		return fillGradient (path, gradient, true, center + originOffset, 0, center, radius, evenOdd, tm);
	}

	void saveGlobalState () const override { stack.push (state); }
	void restoreGlobalState () const override
	{
		if (stack.empty ())
			return;
		state = stack.top ();
		stack.pop ();
	}
	void setLineStyle (const CLineStyle& style) const override { state.lineStyle = style; }
	void setLineWidth (CCoord width) const override { state.lineWidth = width; }
	void setDrawMode (CDrawMode mode) const override { state.drawMode = mode; }
	void setClipRect (CRect clip) const override { state.clip = clip; }
	void setFillColor (CColor color) const override { state.fill = color; }
	void setFrameColor (CColor color) const override { state.frame = color; }
	void setGlobalAlpha (double alpha) const override { state.alpha = alpha; }
	void setTransformMatrix (const TransformMatrix& tm) const override { state.tm = tm; }
	const IPlatformGraphicsDeviceContextBitmapExt* asBitmapExt () const override { return nullptr; }

	// Text, for the font painter.
	void drawText (const std::string& text, CPoint p, CColor color, int style) const
	{
		inContext ([&] () {
			vstgui_web_js_fill_color (color.normRed<double> (), color.normGreen<double> (), color.normBlue<double> (), color.normAlpha<double> () * state.alpha);
			vstgui_web_js_text (text.c_str (), p.x, p.y, style);
		});
	}

private:
	struct State
	{
		CRect clip {};
		CLineStyle lineStyle {kLineSolid};
		CDrawMode drawMode {};
		CColor fill {kTransparentCColor};
		CColor frame {kTransparentCColor};
		CCoord lineWidth {1.};
		double alpha {1.};
		TransformMatrix tm {};
	};

	// Every call: clipped, transformed, and put back as it was after.
	template<typename Proc>
	void inContext (Proc p) const
	{
		if (state.clip.isEmpty ())
			return;
		vstgui_web_js_save ();
		vstgui_web_js_clip (state.clip.left, state.clip.top, state.clip.getWidth (), state.clip.getHeight ());
		const auto& m = state.tm;
		vstgui_web_js_transform (m.m11, m.m21, m.m12, m.m22, m.dx, m.dy);
		p ();
		vstgui_web_js_restore ();
	}
	bool integral () const { return state.drawMode.integralMode (); }
	CPoint align (CPoint p) const
	{
		state.tm.transform (p);
		p.x = std::round (p.x);
		p.y = std::round (p.y);
		state.tm.inverse ().transform (p);
		return p;
	}
	CRect align (CRect r) const
	{
		state.tm.transform (r);
		r.left = std::round (r.left); r.right = std::round (r.right);
		r.top = std::round (r.top); r.bottom = std::round (r.bottom);
		state.tm.inverse ().transform (r);
		return r;
	}
	// A line of odd whole width is drawn half a pixel over, so it covers whole pixels.
	double lineTranslate () const
	{
		auto w = static_cast<int32_t> (state.lineWidth);
		return integral () && static_cast<CCoord> (w) == state.lineWidth && (w % 2) ? 0.5 : 0.;
	}
	void applyFill () const
	{
		auto c = state.fill;
		vstgui_web_js_fill_color (c.normRed<double> (), c.normGreen<double> (), c.normBlue<double> (), c.normAlpha<double> () * state.alpha);
	}
	void applyLineStyle () const
	{
		auto c = state.frame;
		vstgui_web_js_stroke_color (c.normRed<double> (), c.normGreen<double> (), c.normBlue<double> (), c.normAlpha<double> () * state.alpha);
		const auto& style = state.lineStyle;
		std::vector<double> dash;
		for (auto l : style.getDashLengths ())
			dash.push_back (l * state.lineWidth);
		vstgui_web_js_line_style (state.lineWidth, static_cast<int> (style.getLineCap ()), static_cast<int> (style.getLineJoin ()),
		                          dash.data (), static_cast<int> (dash.size ()), style.getDashPhase ());
	}
	void draw (PlatformGraphicsDrawStyle style) const
	{
		if (style != PlatformGraphicsDrawStyle::Stroked)
		{
			applyFill ();
			vstgui_web_js_fill (0);
		}
		if (style != PlatformGraphicsDrawStyle::Filled)
		{
			applyLineStyle ();
			vstgui_web_js_stroke ();
		}
	}
	void usePath (const WebPath& path, TransformMatrix* tm) const
	{
		if (tm) // drawn through its own transform as well as the context's
		{
			const auto& m = *tm;
			vstgui_web_js_transform (m.m11, m.m21, m.m12, m.m22, m.dx, m.dy); // set by JS as a multiply on top
		}
		if (integral () && !tm)
		{
			auto ops = path.mapped ([this] (CPoint p) { return align (p); });
			vstgui_web_js_path (ops.data (), static_cast<int> (ops.size ()));
		}
		else
			vstgui_web_js_path (path.get ().data (), static_cast<int> (path.get ().size ()));
	}
	bool fillGradient (IPlatformGraphicsPath& path, const IPlatformGradient& gradient, bool radial, CPoint a, double ra,
	                   CPoint b, double rb, bool evenOdd, TransformMatrix* tm) const
	{
		auto web = dynamic_cast<WebPath*> (&path);
		auto g = dynamic_cast<const WebGradient*> (&gradient);
		if (!web || !g)
			return false;
		inContext ([&] () {
			usePath (*web, tm);
			auto stops = g->stops ();
			vstgui_web_js_alpha (state.alpha);
			vstgui_web_js_gradient (radial, a.x, a.y, ra, b.x, b.y, rb, stops.data (), static_cast<int> (stops.size () / 5));
			vstgui_web_js_fill (evenOdd);
		});
		return true;
	}

	const WebGraphicsDevice& device;
	int target;
	double scale;
	mutable State state;
	mutable std::stack<State> stack;
};

class WebGraphicsDevice : public IPlatformGraphicsDevice
{
public:
	PlatformGraphicsDeviceContextPtr createBitmapContext (const PlatformBitmapPtr& bitmap) const override
	{
		auto web = bitmap.cast<WebBitmap> ();
		return web ? std::make_shared<WebGraphicsContext> (*this, web->getId (), web->getScaleFactor ()) : nullptr;
	}
};
const IPlatformGraphicsDevice& WebGraphicsContext::getDevice () const { return device; }

class WebGraphicsDeviceFactory : public IPlatformGraphicsDeviceFactory
{
public:
	PlatformGraphicsDevicePtr getDeviceForScreen (ScreenInfo::Identifier) const override { return device; }
	std::shared_ptr<WebGraphicsDevice> device {std::make_shared<WebGraphicsDevice> ()};
};

/* ---- Fonts ---- */

class WebFont : public IPlatformFont, public IFontPainter
{
public:
	WebFont (const UTF8String& name, CCoord size, int32_t style) : name (name.getString ()), size (size), style (style)
	{
		double m[4] {};
		vstgui_web_js_font (this->name.c_str (), size, style);
		vstgui_web_js_font_metrics (m);
		ascent = m[0]; descent = m[1]; leading = m[2]; capHeight = m[3];
	}
	double getAscent () const override { return ascent; }
	double getDescent () const override { return descent; }
	double getLeading () const override { return leading; }
	double getCapHeight () const override { return capHeight; }
	const IFontPainter* getPainter () const override { return this; }
	void drawString (const PlatformGraphicsDeviceContextPtr& context, IPlatformString* string, const CPoint& p,
	                 const CColor& color, bool) const override
	{
		auto web = std::dynamic_pointer_cast<WebGraphicsContext> (context);
		auto text = dynamic_cast<WebString*> (string);
		if (!web || !text)
			return;
		vstgui_web_js_font (name.c_str (), size, style);
		web->drawText (text->get (), p, color, style);
	}
	CCoord getStringWidth (const PlatformGraphicsDeviceContextPtr&, IPlatformString* string, bool) const override
	{
		auto text = dynamic_cast<WebString*> (string);
		if (!text)
			return 0;
		vstgui_web_js_font (name.c_str (), size, style);
		return vstgui_web_js_text_width (text->get ().c_str ());
	}

private:
	std::string name;
	CCoord size;
	int32_t style;
	double ascent {0}, descent {0}, leading {0}, capHeight {0};
};

/* ---- Timers, resources and tasks ---- */

class WebTimer;
static std::map<int, WebTimer*> timers;
static int nextTimerId = 1;

class WebTimer : public IPlatformTimer
{
public:
	explicit WebTimer (IPlatformTimerCallback* callback) : id (nextTimerId++), callback (callback) {}
	~WebTimer () noexcept override { stop (); }
	bool start (uint32_t ms) override
	{
		timers[id] = this;
		vstgui_web_js_timer_start (id, static_cast<int> (ms));
		return true;
	}
	bool stop () override
	{
		if (timers.erase (id))
			vstgui_web_js_timer_stop (id);
		return true;
	}
	void fire () { if (callback) callback->fire (); }

private:
	int id;
	IPlatformTimerCallback* callback;
};

class WebResourceStream : public IPlatformResourceInputStream
{
public:
	explicit WebResourceStream (std::vector<uint8_t>&& data) : data (std::move (data)) {}
	uint32_t readRaw (void* buffer, uint32_t size) override
	{
		auto n = std::min<uint64_t> (size, data.size () - pos);
		std::copy_n (data.begin () + static_cast<std::ptrdiff_t> (pos), n, static_cast<uint8_t*> (buffer));
		pos += n;
		return static_cast<uint32_t> (n);
	}
	int64_t seek (int64_t to, SeekMode mode) override
	{
		auto base = mode == SeekMode::Set ? 0 : mode == SeekMode::Current ? static_cast<int64_t> (pos) : static_cast<int64_t> (data.size ());
		auto next = base + to;
		if (next < 0 || next > static_cast<int64_t> (data.size ()))
			return kStreamSeekError;
		pos = static_cast<uint64_t> (next);
		return next;
	}
	int64_t tell () override { return static_cast<int64_t> (pos); }

private:
	std::vector<uint8_t> data;
	uint64_t pos {0};
};

// One thread: every queue's tasks run in order on the page's thread, when the frame next draws (or when VSTGUI
// waits for them).
class WebTaskExecutor : public IPlatformTaskExecutor
{
public:
	const Tasks::Queue& getMainQueue () const override { return main; }
	const Tasks::Queue& getBackgroundQueue () const override { return background; }
	Tasks::Queue makeSerialQueue (const char*) const override { return Tasks::Queue {next++}; }
	void releaseSerialQueue (const Tasks::Queue&) const override {}
	void schedule (const Tasks::Queue&, Tasks::Task&& task) const override { tasks.push_back (std::move (task)); }
	void waitAllTasksExecuted (const Tasks::Queue&) const override { run (); }
	void waitAllTasksExecuted () const override { run (); }
	void run () const
	{
		while (!tasks.empty ())
		{
			auto task = std::move (tasks.front ());
			tasks.pop_front ();
			task ();
		}
	}

private:
	Tasks::Queue main {0}, background {1};
	mutable uint64_t next {2};
	mutable std::deque<Tasks::Task> tasks;
};

/* ---- The frame ---- */

class WebFrame;
static WebFrame* currentFrame = nullptr;

class WebFrame : public IPlatformFrame, public IGenericOptionMenuListener
{
public:
	WebFrame (IPlatformFrameCallback* callback, const CRect& size, PlatformType type)
	: IPlatformFrame (callback), size (size), type (type)
	{
		currentFrame = this;
		dirty.push_back (CRect (0, 0, size.getWidth (), size.getHeight ()));
		vstgui_web_js_invalidate ();
	}
	~WebFrame () noexcept override
	{
		if (currentFrame == this)
			currentFrame = nullptr;
	}

	bool getGlobalPosition (CPoint& pos) const override { pos = {}; return true; }
	bool setSize (const CRect& newSize) override
	{
		size = newSize;
		return invalidRect (CRect (0, 0, size.getWidth (), size.getHeight ()));
	}
	bool getSize (CRect& s) const override { s = size; return true; }
	bool getCurrentMousePosition (CPoint& p) const override { p = mouse; return true; }
	bool getCurrentMouseButtons (CButtonState& b) const override { b = buttons; return true; }
	bool getCurrentModifiers (Modifiers& m) const override { m = modifiers; return true; }
	bool setMouseCursor (CCursorType cursor) override { vstgui_web_js_cursor (cursor); return true; }
	bool invalidRect (const CRect& rect) override
	{
		dirty.push_back (rect);
		vstgui_web_js_invalidate ();
		return true;
	}
	bool scrollRect (const CRect&, const CPoint&) override { return false; }
	bool showTooltip (const CRect&, const char* text) override { vstgui_web_js_tooltip (text ? text : ""); return true; }
	bool hideTooltip () override { vstgui_web_js_tooltip (""); return true; }
	void* getPlatformRepresentation () const override { return const_cast<WebFrame*> (this); }
	SharedPointer<IPlatformTextEdit> createPlatformTextEdit (IPlatformTextEditCallback* textEdit) override
	{
		return makeOwned<GenericTextEdit> (textEdit);
	}
	SharedPointer<IPlatformOptionMenu> createPlatformOptionMenu () override
	{
		auto cFrame = dynamic_cast<CFrame*> (frame);
		GenericOptionMenuTheme theme;
		if (optionMenuTheme)
			theme = *optionMenuTheme;
		auto menu = makeOwned<GenericOptionMenu> (cFrame, MouseEventButtonState (MouseButton::Left), theme);
		menu->setListener (this);
		return menu;
	}
#if VSTGUI_OPENGL_SUPPORT
	SharedPointer<IPlatformOpenGLView> createPlatformOpenGLView () override { return nullptr; }
#endif
	SharedPointer<IPlatformViewLayer> createPlatformViewLayer (IPlatformViewLayerDelegate*, IPlatformViewLayer*) override { return nullptr; }
#if VSTGUI_ENABLE_DEPRECATED_METHODS
	DragResult doDrag (IDataPackage*, const CPoint&, CBitmap*) override { return kDragError; }
#endif
	bool doDrag (const DragDescription&, const SharedPointer<IDragCallback>&) override { return false; }
	PlatformType getPlatformType () const override { return type; }
	void onFrameClosed () override {}
	Optional<UTF8String> convertCurrentKeyEventToText () override
	{
		if (keyText.empty ())
			return {};
		return Optional<UTF8String> (UTF8String (keyText));
	}
	bool setupGenericOptionMenu (bool, GenericOptionMenuTheme* theme) override
	{
		optionMenuTheme = theme ? std::make_unique<GenericOptionMenuTheme> (*theme) : nullptr;
		return true;
	}
	void optionMenuPopupStarted () override {}
	void optionMenuPopupStopped () override {}

	/* ---- Driven by the page ---- */

	bool draw (double scale)
	{
		if (dirty.empty ())
			return false;
		auto rects = std::move (dirty);
		dirty.clear ();
		auto context = std::make_shared<WebGraphicsContext> (device (), 0, scale);
		context->beginDraw ();
		frame->platformDrawRects (context, scale, rects);
		context->endDraw ();
		return true;
	}
	void onMouse (int kind, double x, double y, int buttonBits, int mods, int clicks)
	{
		mouse = CPoint (x, y);
		modifiers = toModifiers (mods);
		MouseEventButtonState state;
		if (buttonBits & 1) state.add (MouseButton::Left);
		if (buttonBits & 2) state.add (MouseButton::Right);
		if (buttonBits & 4) state.add (MouseButton::Middle);
		buttons = CButtonState ((buttonBits & 1 ? kLButton : 0) | (buttonBits & 2 ? kRButton : 0) | (buttonBits & 4 ? kMButton : 0));
		if (kind == 0 || kind == 1 || kind == 2)
		{
			auto send = [&] (MouseDownUpMoveEvent&& e) {
				e.mousePosition = mouse;
				e.modifiers = modifiers;
				e.buttonState = state;
				e.clickCount = static_cast<uint32_t> (std::max (1, clicks));
				frame->platformOnEvent (e);
			};
			if (kind == 0) send (MouseDownEvent ());
			else if (kind == 1) send (MouseMoveEvent ());
			else send (MouseUpEvent ());
		}
		else
		{
			MouseExitEvent e;
			e.mousePosition = mouse;
			e.modifiers = modifiers;
			frame->platformOnEvent (e);
		}
	}
	void onWheel (double x, double y, double dx, double dy, int mods)
	{
		MouseWheelEvent e;
		e.mousePosition = mouse = CPoint (x, y);
		e.modifiers = modifiers = toModifiers (mods);
		e.deltaX = dx;
		e.deltaY = dy;
		frame->platformOnEvent (e);
	}
	bool onKey (bool down, int virt, char32_t character, int mods, bool repeat)
	{
		KeyboardEvent e (down ? EventType::KeyDown : EventType::KeyUp);
		e.virt = static_cast<VirtualKey> (virt);
		e.character = character;
		e.modifiers = modifiers = toModifiers (mods);
		e.isRepeat = repeat;
		keyText.clear ();
		if (character >= 0x20 && !(mods & (4 | 8)))
			keyText = utf8 (character);
		frame->platformOnEvent (e);
		keyText.clear ();
		return e.consumed;
	}
	void onFocus (bool on) { frame->platformOnActivate (on); }

private:
	static Modifiers toModifiers (int bits)
	{
		Modifiers m;
		if (bits & 1) m.add (ModifierKey::Shift);
		if (bits & 2) m.add (ModifierKey::Alt);
		if (bits & 4) m.add (ModifierKey::Control);
		if (bits & 8) m.add (ModifierKey::Super);
		return m;
	}
	static std::string utf8 (char32_t c)
	{
		std::string s;
		if (c < 0x80) s += static_cast<char> (c);
		else if (c < 0x800) { s += static_cast<char> (0xC0 | (c >> 6)); s += static_cast<char> (0x80 | (c & 0x3F)); }
		else if (c < 0x10000) { s += static_cast<char> (0xE0 | (c >> 12)); s += static_cast<char> (0x80 | ((c >> 6) & 0x3F)); s += static_cast<char> (0x80 | (c & 0x3F)); }
		else { s += static_cast<char> (0xF0 | (c >> 18)); s += static_cast<char> (0x80 | ((c >> 12) & 0x3F)); s += static_cast<char> (0x80 | ((c >> 6) & 0x3F)); s += static_cast<char> (0x80 | (c & 0x3F)); }
		return s;
	}
	static const WebGraphicsDevice& device ();

	CRect size;
	PlatformType type;
	std::vector<CRect> dirty;
	CPoint mouse;
	CButtonState buttons;
	Modifiers modifiers;
	std::string keyText;
	std::unique_ptr<GenericOptionMenuTheme> optionMenuTheme;
};

/* ---- The factory ---- */

class WebFactory : public IPlatformFactory
{
public:
	void finalize () noexcept override { executor->waitAllTasksExecuted (); }
	uint64_t getTicks () const noexcept override
	{
		using namespace std::chrono;
		return duration_cast<milliseconds> (steady_clock::now ().time_since_epoch ()).count ();
	}
	PlatformFramePtr createFrame (IPlatformFrameCallback* frame, const CRect& size, void*, PlatformType type, IPlatformFrameConfig*) const noexcept override
	{
		return makeOwned<WebFrame> (frame, size, type);
	}
	PlatformFontPtr createFont (const UTF8String& name, const CCoord& size, const int32_t& style) const noexcept override
	{
		return makeOwned<WebFont> (name, size, style);
	}
	bool getAllFontFamilies (const FontFamilyCallback& callback) const noexcept override
	{
		for (auto name : {"Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "sans-serif", "serif", "monospace"})
			if (!callback (name))
				break;
		return true;
	}
	PlatformBitmapPtr createBitmap (const CPoint& size) const noexcept override
	{
		auto id = vstgui_web_js_bitmap_new (static_cast<int> (size.x), static_cast<int> (size.y));
		return id ? makeOwned<WebBitmap> (id, size) : nullptr;
	}
	PlatformBitmapPtr createBitmap (const CResourceDescription& desc) const noexcept override
	{
		if (desc.type != CResourceDescription::kStringType || !desc.u.name)
			return nullptr;
		return load (desc.u.name);
	}
	PlatformBitmapPtr createBitmapFromPath (UTF8StringPtr path) const noexcept override
	{
		if (!path)
			return nullptr;
		std::string p (path);
		auto slash = p.find_last_of ('/');
		return load (slash == std::string::npos ? p : p.substr (slash + 1));
	}
	// PNG bytes in memory (a compressed .uidesc's own bitmaps): the browser can't decode those synchronously.
	PlatformBitmapPtr createBitmapFromMemory (const void*, uint32_t) const noexcept override { return nullptr; }
	PNGBitmapBuffer createBitmapMemoryPNGRepresentation (const PlatformBitmapPtr&) const noexcept override { return {}; }
	PlatformResourceInputStreamPtr createResourceInputStream (const CResourceDescription& desc) const noexcept override
	{
		if (desc.type != CResourceDescription::kStringType || !desc.u.name)
			return nullptr;
		auto size = vstgui_web_js_resource_size (desc.u.name);
		if (size < 0)
			return nullptr;
		std::vector<uint8_t> data (static_cast<size_t> (size));
		vstgui_web_js_resource_read (desc.u.name, data.data ());
		return std::make_unique<WebResourceStream> (std::move (data));
	}
	PlatformStringPtr createString (UTF8StringPtr s) const noexcept override { return makeOwned<WebString> (s); }
	PlatformTimerPtr createTimer (IPlatformTimerCallback* callback) const noexcept override { return makeOwned<WebTimer> (callback); }
	bool setClipboard (const DataPackagePtr& data) const noexcept override
	{
		if (!data || data->getCount () == 0)
			return false;
		const void* buffer = nullptr;
		IDataPackage::Type type;
		auto size = data->getData (0, buffer, type);
		if (type != IDataPackage::kText || !buffer)
			return false;
		vstgui_web_js_clipboard (std::string (static_cast<const char*> (buffer), size).c_str ());
		return true;
	}
	DataPackagePtr getClipboard () const noexcept override { return nullptr; }
	PlatformGradientPtr createGradient () const noexcept override { return std::make_unique<WebGradient> (); }
	PlatformFileSelectorPtr createFileSelector (PlatformFileSelectorStyle, IPlatformFrame*) const noexcept override { return nullptr; }
	const IPlatformGraphicsDeviceFactory& getGraphicsDeviceFactory () const noexcept override { return devices; }
	const IPlatformTaskExecutor& getTaskExecutor () const noexcept override { return *executor; }
	bool replaceTaskExecutor (const ReplaceTaskExecFunc& replace) const noexcept override
	{
		executor = replace (std::move (executor));
		return true;
	}
	const LinuxFactory* asLinuxFactory () const noexcept override { return nullptr; }
	const MacFactory* asMacFactory () const noexcept override { return nullptr; }
	const Win32Factory* asWin32Factory () const noexcept override { return nullptr; }

	void runTasks () const
	{
		if (auto web = dynamic_cast<WebTaskExecutor*> (executor.get ()))
			web->run ();
	}
	WebGraphicsDeviceFactory devices;

private:
	PlatformBitmapPtr load (const std::string& name) const
	{
		int size[2] {};
		auto id = vstgui_web_js_bitmap_load (name.c_str (), size);
		return id ? makeOwned<WebBitmap> (id, CPoint (size[0], size[1])) : nullptr;
	}
	mutable PlatformTaskExecutorPtr executor {std::make_unique<WebTaskExecutor> ()};
};

const WebGraphicsDevice& WebFrame::device ()
{
	return *static_cast<const WebFactory&> (getPlatformFactory ()).devices.device;
}

/* ---- In place of lib/platform/platformfactory.cpp, which picks X11 under Linux ---- */

static PlatformFactoryPtr gPlatformFactory;
void setPlatformFactory (PlatformFactoryPtr&& f) { gPlatformFactory = std::move (f); }
void initPlatform (PlatformInstanceHandle) { setPlatformFactory (std::make_unique<WebFactory> ()); }
void exitPlatform ()
{
	if (gPlatformFactory)
		gPlatformFactory->finalize ();
	setPlatformFactory (nullptr);
}
const IPlatformFactory& getPlatformFactory () { return *gPlatformFactory; }

} // VSTGUI

/* ---- What vst3web.cpp calls ---- */

using namespace VSTGUI;

extern "C" {

int vstgui_web_draw (double scale)
{
	static_cast<const WebFactory&> (getPlatformFactory ()).runTasks ();
	return currentFrame && currentFrame->draw (scale) ? 1 : 0;
}
void vstgui_web_mouse (int type, double x, double y, int buttons, int modifiers, int clicks)
{
	if (currentFrame)
		currentFrame->onMouse (type, x, y, buttons, modifiers, clicks);
}
void vstgui_web_wheel (double x, double y, double dx, double dy, int modifiers)
{
	if (currentFrame)
		currentFrame->onWheel (x, y, dx, dy, modifiers);
}
int vstgui_web_key (int down, int virt, unsigned character, int modifiers, int repeat)
{
	return currentFrame && currentFrame->onKey (down != 0, virt, static_cast<char32_t> (character), modifiers, repeat != 0) ? 1 : 0;
}
void vstgui_web_timer (int id)
{
	auto it = timers.find (id);
	if (it != timers.end ())
		it->second->fire ();
}
void vstgui_web_focus (int on)
{
	if (currentFrame)
		currentFrame->onFocus (on != 0);
}

} // extern "C"

// The SDK's VSTGUIEditor hands Linux hosts' run loops to VSTGUI's X11 backend; here the page is the run loop.
namespace Steinberg { namespace Linux {
bool setupVSTGUIRunloop (FUnknown*) { return true; }
}}

// The SDK's module initializers ask for the module's handle (on Linux, its shared object, to find its
// resources); here resources come from the page, so there is none.
void* moduleHandle = nullptr;
