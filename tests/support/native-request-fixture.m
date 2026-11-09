#import <Foundation/Foundation.h>
#include <stdio.h>
#include <string.h>
#include <objc/runtime.h>

static NSString *text(const char *value) { return [NSString stringWithUTF8String:value]; }

unsigned probe_request(const char *address) {
 unsigned checks = 0;
 NSURL *url = [NSURL URLWithString:text(address)];
 NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:2.75];
 if (request && strcmp([[[request URL] absoluteString] UTF8String], address) == 0) checks |= 1;
 if ([request cachePolicy] == 1 && [request timeoutInterval] == 2.75) checks |= 2;
 if (strcmp([[request HTTPMethod] UTF8String], "GET") == 0) checks |= 4;
 [request setHTTPMethod:text("POST")];
 if (strcmp([[request HTTPMethod] UTF8String], "POST") == 0) checks |= 8;
 [request setValue:text("one") forHTTPHeaderField:text("X-Test")];
 if (strcmp([[request valueForHTTPHeaderField:text("x-test")] UTF8String], "one") == 0) checks |= 16;
 NSURLRequest *copy = [request copy];
 [request setValue:text("two") forHTTPHeaderField:text("X-Test")];
 if (strcmp([[copy valueForHTTPHeaderField:text("x-test")] UTF8String], "one") == 0) checks |= 32;
 NSMutableURLRequest *mutable = [copy mutableCopy];
 [mutable setTimeoutInterval:7.125];
 if ([mutable timeoutInterval] == 7.125 && [copy timeoutInterval] == 2.75) checks |= 64;
 [request setValue:nil forHTTPHeaderField:text("x-test")];
 if (![request valueForHTTPHeaderField:text("X-Test")]) checks |= 128;
 [mutable release]; [copy release]; return checks;
}

unsigned probe_data(void) {
 unsigned checks = 0; unsigned char input[] = {0, 1, 2, 254, 255};
 NSData *data = [NSData dataWithBytes:input length:sizeof(input)]; input[0] = 9;
 if ([data length] == 5 && ((const unsigned char *)[data bytes])[0] == 0) checks |= 1;
 unsigned char output[8]; memset(output, 0x5a, sizeof(output)); [data getBytes:output length:sizeof(output)];
 if (output[0] == 0 && output[4] == 255 && output[5] == 0x5a) checks |= 2;
 [data getBytes:output range:NSMakeRange(1, 3)]; if (output[0] == 1 && output[2] == 254) checks |= 4;
 NSData *copy = [data copy]; if ([copy isEqualToData:data]) checks |= 8; [copy release];
 NSData *empty = [NSData data]; if ([empty length] == 0 && [empty bytes] == NULL) checks |= 16;
 if (CFDataGetLength((CFDataRef)data) == 5) checks |= 32;
 CFDataRef bridge = CFDataCreateCopy(NULL, (CFDataRef)data);
 if ([(NSData *)bridge length] == 5 && ((const unsigned char *)[(NSData *)bridge bytes])[4] == 255) checks |= 64;
 CFRelease(bridge);
 NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:text("https://example.invalid/")]];
 [request setHTTPBody:data]; if ([[request HTTPBody] length] == 5) checks |= 128;
 return checks;
}

unsigned probe_mutable_data(void) {
 unsigned checks = 0; unsigned char input[] = {1, 2, 3};
 NSMutableData *data = [NSMutableData data]; [data appendBytes:input length:3];
 if ([data length] == 3 && ((unsigned char *)[data mutableBytes])[2] == 3) checks |= 1;
 NSData *copy = [data copy]; [data appendData:data]; if ([data length] == 6 && [copy length] == 3) checks |= 2;
 [data setLength:8]; if (((unsigned char *)[data mutableBytes])[7] == 0) checks |= 4;
 [data replaceBytesInRange:NSMakeRange(1, 6) withBytes:input length:3]; if ([data length] == 5 && ((unsigned char *)[data mutableBytes])[3] == 3) checks |= 8;
 [data resetBytesInRange:NSMakeRange(0, 2)]; if (((unsigned char *)[data mutableBytes])[0] == 0) checks |= 16;
 NSMutableData *other = [copy mutableCopy]; [other increaseLengthBy:2]; if ([other length] == 5 && [copy length] == 3) checks |= 32;
 [data setData:copy]; if ([data isEqualToData:copy]) checks |= 64;
 if ([[NSMutableData dataWithLength:4] length] == 4 && [[NSMutableData dataWithCapacity:4096] length] == 0) checks |= 128;
 [other release]; [copy release]; return checks;
}

unsigned probe_ivars(void) {
 unsigned checks = 0;
 Class parent = objc_allocateClassPair([NSObject class], "CodexPointerParent", 0);
 if (!parent) return 0;
 class_addIvar(parent, "pointer", sizeof(void *), 3, "^v"); objc_registerClassPair(parent);
 Class child = objc_allocateClassPair(parent, "CodexPointerChild", 0); objc_registerClassPair(child);
 id object = class_createInstance(child, 0); void *value = NULL;
 Ivar variable = class_getInstanceVariable(parent, "pointer");
 void *expected = (void *)(uintptr_t)0xfedcba9876543210ull;
 if (object_setInstanceVariable(object, "pointer", expected) == variable) checks |= 1;
 if (object_getInstanceVariable(object, "pointer", &value) == variable && value == expected) checks |= 2;
 if (object_getInstanceVariable(object, "pointer", NULL) == variable) checks |= 4;
 if (!object_setInstanceVariable(object, "missing", NULL)) checks |= 8;
 value = (void *)0x1234; if (!object_getInstanceVariable(object, "missing", &value) && value == NULL) checks |= 16;
 value = (void *)0x1234; if (!object_getInstanceVariable(nil, "pointer", &value) && value == NULL) checks |= 32;
 if (!object_setInstanceVariable(nil, "pointer", NULL)) checks |= 64;
 object_dispose(object); objc_disposeClassPair(child); objc_disposeClassPair(parent);
 return checks;
}

#ifdef NATIVE
int main(void) {
 NSAutoreleasePool *pool = [[NSAutoreleasePool alloc] init];
 printf("%u\n", probe_request("https://example.invalid/api/"));
 printf("%u\n", probe_data());
 printf("%u\n", probe_mutable_data());
 printf("%u\n", probe_ivars());
 NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:text("https://example.invalid/")]];
 [request setValue:text("one") forHTTPHeaderField:text("x-Test")]; [request addValue:text("two") forHTTPHeaderField:text("X-TEST")];
 printf("%g %s %s\n", [request timeoutInterval], [[request HTTPMethod] UTF8String], [[request valueForHTTPHeaderField:text("X-test")] UTF8String]);
 [request setHTTPMethod:text("post")]; [request setTimeoutInterval:0];
 printf("%g %s\n", [request timeoutInterval], [[request HTTPMethod] UTF8String]);
 const char *methods[] = {"get", "put", "patch", "head", "delete", "options", "trace", "connect", "CuStOm"};
 for (unsigned index = 0; index < sizeof(methods) / sizeof(methods[0]); index++) { [request setHTTPMethod:text(methods[index])]; printf("%s\n", [[request HTTPMethod] UTF8String]); }
 [pool drain]; return 0;
}
#endif
