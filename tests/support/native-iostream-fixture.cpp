#include <cstddef>
#include <cstring>
#include <locale>
#include <ostream>
#include <streambuf>
#include <memory>

struct ArrayStream : std::basic_streambuf<char, std::char_traits<char>> {
 explicit ArrayStream(char *destination, size_t size) { static const std::locale classic(std::locale::classic()); imbue(classic); setp(destination, destination + size); }
 size_t used() { return size_t(pptr() - pbase()); }
};

static char results[8192];
static size_t cursor;
template <typename Configure> static void record(Configure configure) {
 char text[128];
 ArrayStream stream(text, sizeof text);
 { std::ostream output(&stream); configure(output); }
 size_t count = stream.used();
 memcpy(results + cursor, text, count); cursor += count; results[cursor++] = '\n';
}

extern "C" const char *probe_iostream(void) {
 cursor = 0;
 const double values[] = { 48000, 44100.5, 0, -0.0, 1, 0.1, 2.5, 3.5, 1234567, 1e21, 1.5e-7, 0.0001, 0.00001234, 999999.5, 123456.5, 5e-324, 1.7976931348623157e308, -273.15 };
 for (double value : values) {
  record([&](std::ostream &o) { o << value; });
  record([&](std::ostream &o) { o.setf(std::ios_base::fixed); o.precision(3); o << value; });
  if (value > -1e300 && value < 1e20) record([&](std::ostream &o) { o.setf(std::ios_base::fixed); o.precision(1); o << value; });
  record([&](std::ostream &o) { o.setf(std::ios_base::scientific); o.precision(2); o << value; });
  record([&](std::ostream &o) { o.precision(1); o << value; });
  record([&](std::ostream &o) { o.precision(17); o << value; });
  record([&](std::ostream &o) { o.setf(std::ios_base::showpoint); o << value; });
 }
 record([](std::ostream &o) { o.setf(std::ios_base::scientific); o.setf(std::ios_base::uppercase); o.precision(3); o << 1234.5; });
 record([](std::ostream &o) { o << 42 << ' ' << -7 << ' ' << 4000000000u << ' ' << -9000000000L << ' ' << 18000000000000000000UL; });
 record([](std::ostream &o) { o.setf(std::ios_base::hex, std::ios_base::basefield); o.setf(std::ios_base::showbase); o << 255; });
 record([](std::ostream &o) { o.setf(std::ios_base::oct, std::ios_base::basefield); o << 64; });
 record([](std::ostream &o) { o.width(8); o << 12.5; o << 3; });
 record([](std::ostream &o) { o.setf(std::ios_base::left, std::ios_base::adjustfield); o.width(6); o << 7; o << '|'; });
 record([](std::ostream &o) { o.setf(std::ios_base::showpos); o << 7 << ' ' << 1.5; });
 record([](std::ostream &o) { o.write("abc", 3); o.put('d'); o.flush(); });
 results[cursor] = 0;
 return results;
}

extern "C" int probe_weak(void) {
 static int destroyed;
 struct Counted { ~Counted() { destroyed++; } };
 destroyed = 0;
 int result = 0;
 std::weak_ptr<Counted> outer;
 {
  std::shared_ptr<Counted> strong(new Counted);
  std::weak_ptr<Counted> weak = strong, copy = weak;
  outer = copy;
  result += strong.use_count() == 1 ? 1 : 0;
  { auto locked = weak.lock(); result += locked && strong.use_count() == 2 ? 2 : 0; }
  result += strong.use_count() == 1 ? 4 : 0;
 }
 result += destroyed == 1 ? 8 : 0;
 result += outer.expired() && !outer.lock() ? 16 : 0;
 return result;
}

#ifdef NATIVE
#include <stdio.h>
int main() { fputs(probe_iostream(), stdout); printf("weak %d\n", probe_weak()); return 0; }
#endif
