#import <Foundation/Foundation.h>
#include <stdio.h>
#include <string.h>

unsigned probe_session(void) {
 unsigned checks = 0;
 NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
 [configuration setTimeoutIntervalForRequest:2.75];
 NSObject *delegate = [[NSObject alloc] init];
 NSOperationQueue *queue = [NSOperationQueue mainQueue];
 NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:(id<NSURLSessionDelegate>)delegate delegateQueue:queue];
 if (session && [session delegate] == delegate && [session delegateQueue] == queue) checks |= 1;
 NSURLSessionConfiguration *first = [session configuration];
 if (first != configuration && [first timeoutIntervalForRequest] == 2.75) checks |= 2;
 [configuration setTimeoutIntervalForRequest:7.125];
 if ([[session configuration] timeoutIntervalForRequest] == 2.75) checks |= 4;
 [first setTimeoutIntervalForRequest:1];
 if ([[session configuration] timeoutIntervalForRequest] == 2.75) checks |= 8;
 if ([session sessionDescription] == nil) checks |= 16;
 NSString *description = [NSString stringWithUTF8String:"guest session"];
 [session setSessionDescription:description];
 if (strcmp([[session sessionDescription] UTF8String], "guest session") == 0) checks |= 32;
 [session setSessionDescription:nil];
 if ([session sessionDescription] == nil) checks |= 64;
 NSURLSession *automatic = [NSURLSession sessionWithConfiguration:configuration];
 if ([automatic delegate] == nil && [automatic delegateQueue] != nil && [[automatic delegateQueue] maxConcurrentOperationCount] == 1) checks |= 128;
 if ([[automatic configuration] timeoutIntervalForRequest] == 7.125) checks |= 256;
#ifdef NATIVE
 [session finishTasksAndInvalidate]; [automatic finishTasksAndInvalidate];
#endif
 [delegate release]; return checks;
}

#ifdef NATIVE
int main(void) {
 @autoreleasepool { printf("%u\n", probe_session()); }
 return 0;
}
#endif
