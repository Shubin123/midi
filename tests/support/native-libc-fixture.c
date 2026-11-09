#include <errno.h>
#include <fnmatch.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static unsigned char output[4096];
static size_t used;
static void bytes(const void *value, size_t size) { memcpy(output + used, value, size); used += size; }
static void real(double value) { bytes(&value, 8); }
static void single(float value) { bytes(&value, 4); }
static void whole(int64_t value) { bytes(&value, 8); }

unsigned char *probe_libc(size_t *size) {
 const char *numbers[] = { "  -42xyz", "0x1F", "077", "99999999999999999999", "-99999999999999999999", "zz", "+7", "0xg", "" };
 int bases[] = { 10, 0, 0, 10, 10, 36, 10, 16, 10 };
 used = 0;
 for (int index = 0; index < 9; index++) {
  char *end; errno = 0;
  long long value = strtoll(numbers[index], &end, bases[index]); whole(value); whole(end - numbers[index]); whole(errno);
 }
 double values[] = { 2.5, -2.5, 3.5, 0.49999999999999994, -0.0, 1e300, 7.25, 1e-310 };
 for (int index = 0; index < 8; index++) {
  int exponent; double part, value = values[index];
  real(round(value)); single(roundf((float)value)); real(frexp(value, &exponent)); whole(exponent); real(modf(value, &part)); real(part);
  real(sinh(value / 1e290)); real(atan2(value, 2.0)); real(fmod(value, 3.0));
  if (fabs(value) < 1e18) { whole(lrint(value)); whole(lround(value)); }
 }
 real(ldexp(1.5, 10)); real(ldexp(1.0, -1074)); real(logb(1000.0)); single(fmodf(5.5f, 3.0f)); single(floorf(-1.5f)); single(ceilf(-1.5f));
 whole(strcasecmp("AbC", "aBc") == 0); whole(strncasecmp("abX", "ABy", 2) == 0); whole(strcasecmp("a", "B") < 0);
 whole(strstr("hello world", "o w") != 0); whole(strstr("abc", "abd") == 0);
 char buffer[6]; whole(strlcpy(buffer, "abcdefghij", 6)); bytes(buffer, 6);
 char padded[6]; strncpy(padded, "ab", 6); bytes(padded, 6);
 struct { const char *pattern, *text; int flags; } globs[] = {
  { "*.png", "image.png", 0 }, { "*.png", "image.PNG", 0 }, { "*.png", "image.PNG", FNM_CASEFOLD }, { "*", "", 0 }, { "?", "", 0 }, { "a?c", "abc", 0 }, { "a?c", "ac", 0 },
  { "[abc]x", "bx", 0 }, { "[!abc]x", "bx", 0 }, { "[a-c]x", "dx", 0 }, { "[^a-c]x", "dx", 0 }, { "*.*", "noext", 0 }, { "*", ".hidden", FNM_PERIOD }, { ".*", ".hidden", FNM_PERIOD },
  { "*/b", "a/b", FNM_PATHNAME }, { "*", "a/b", FNM_PATHNAME }, { "*", "a/b", 0 }, { "a\\*c", "a*c", 0 }, { "a\\*c", "abc", 0 }, { "a*b*c", "axxbyyc", 0 }, { "a*b*c", "axxbyy", 0 }, { "[", "[", 0 }, { "**x", "aax", 0 },
 };
 for (size_t index = 0; index < sizeof globs / sizeof *globs; index++) whole(fnmatch(globs[index].pattern, globs[index].text, globs[index].flags));
 *size = used; return output;
}

#ifdef NATIVE
#include <stdio.h>
int main(void) { size_t size; unsigned char *data = probe_libc(&size); for (size_t index = 0; index < size; index++) printf("%02x", data[index]); putchar('\n'); return 0; }
#endif
