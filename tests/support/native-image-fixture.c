#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <stdint.h>
#include <string.h>

static void released(void *info, const void *data, size_t size) { (*(int *)info)++; }

int probe_image(const uint8_t *png, size_t length, uint8_t *pixels, size_t capacity, int *width, int *height, int *alpha, int *releases) {
 *releases = 0;
 CGDataProviderRef provider = CGDataProviderCreateWithData(releases, png, length, released);
 CGImageSourceRef source = CGImageSourceCreateWithDataProvider(provider, NULL);
 CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
 int result = 0;
 if (image) {
  *width = (int)CGImageGetWidth(image); *height = (int)CGImageGetHeight(image);
  CGImageAlphaInfo info = CGImageGetAlphaInfo(image);
  *alpha = info != kCGImageAlphaNone && info != kCGImageAlphaNoneSkipFirst && info != kCGImageAlphaNoneSkipLast;
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  memset(pixels, 0, capacity);
  CGContextRef context = CGBitmapContextCreate(pixels, *width, *height, 8, *width * 4, space, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGContextDrawImage(context, CGRectMake(0, 0, *width, *height), image);
  CGContextFlush(context);
  CGContextRelease(context); CGColorSpaceRelease(space); CGImageRelease(image);
  result = 1;
 }
 if (source) CFRelease(source);
 CGDataProviderRelease(provider);
 return result;
}

#ifdef NATIVE
#include <stdio.h>
#include <stdlib.h>
int main(int count, char **values) {
 FILE *file = fopen(values[1], "rb"); uint8_t png[1 << 16]; size_t length = fread(png, 1, sizeof png, file); fclose(file);
 uint8_t *pixels = malloc(1 << 16); int width = 0, height = 0, alpha = 0, releases = 0;
 int ok = probe_image(png, length, pixels, 1 << 16, &width, &height, &alpha, &releases);
 printf("%d %d %d %d %d\n", ok, width, height, alpha, releases);
 for (int index = 0; index < width * height * 4; index++) printf("%02x", pixels[index]);
 putchar('\n'); return 0;
}
#endif
