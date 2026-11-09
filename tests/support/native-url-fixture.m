#import <Foundation/Foundation.h>
#include <stdio.h>

int main(int argc, char **argv) {
 NSAutoreleasePool *pool = [[NSAutoreleasePool alloc] init];
 for (int index = 1; index < argc; index++) {
  NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:argv[index]]];
  id empty = [NSNull null];
  NSArray *fields = url ? @[[url absoluteString] ?: empty, [url relativeString] ?: empty, [url scheme] ?: empty, [url host] ?: empty, [url path] ?: empty, [url query] ?: empty, [url fragment] ?: empty] : @[empty];
  NSData *data = [NSJSONSerialization dataWithJSONObject:fields options:0 error:NULL];
  fwrite([data bytes], 1, [data length], stdout); putchar('\n');
 }
 [pool drain]; return 0;
}
