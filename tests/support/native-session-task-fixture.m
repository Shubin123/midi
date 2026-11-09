#import <Foundation/Foundation.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

unsigned probe_session_task(void) {
 unsigned checks = 0;
 NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
 [configuration setTimeoutIntervalForRequest:7.125];
 NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
 NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:"https://example.invalid/task"]];
 NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
 [request setHTTPMethod:[NSString stringWithUTF8String:"POST"]];
 unsigned char body[] = {1, 2, 3}; [request setHTTPBody:[NSData dataWithBytes:body length:3]];
 NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
 if ([task state] == NSURLSessionTaskStateSuspended && [task taskIdentifier] == 1) checks |= 1;
 if ([task priority] == 0.5f && [task taskDescription] == nil) checks |= 2;
 if ([task response] == nil && [task error] == nil && [task countOfBytesSent] == 0 && [task countOfBytesReceived] == 0) checks |= 4;
 if ([task countOfBytesExpectedToReceive] == 0 && [task countOfBytesExpectedToSend] == 0) checks |= 8;
 if (strcmp([[[task originalRequest] HTTPMethod] UTF8String], "POST") == 0 && [[[task originalRequest] HTTPBody] length] == 3) checks |= 16;
 [request setHTTPMethod:[NSString stringWithUTF8String:"GET"]]; [request setHTTPBody:nil];
 if (strcmp([[[task currentRequest] HTTPMethod] UTF8String], "POST") == 0 && [[[task currentRequest] HTTPBody] length] == 3) checks |= 32;
 [task setPriority:0.75f]; [task setTaskDescription:[NSString stringWithUTF8String:"guest task"]];
 if ([task priority] == 0.75f && strcmp([[task taskDescription] UTF8String], "guest task") == 0) checks |= 64;
 NSURLSessionDataTask *second = [session dataTaskWithRequest:request];
 if ([second taskIdentifier] == 2 && [task taskIdentifier] == 1 && [second state] == NSURLSessionTaskStateSuspended) checks |= 128;
#ifdef NATIVE
 printf("%.3f %.3f %lld %lld %lld\n", [[task originalRequest] timeoutInterval], [[task currentRequest] timeoutInterval], (long long)[task countOfBytesExpectedToSend], (long long)[second countOfBytesExpectedToSend], (long long)[task countOfBytesExpectedToReceive]);
 float priorities[] = {-1, 2, NAN, INFINITY};
 for (unsigned index = 0; index < sizeof(priorities) / sizeof(*priorities); index++) { [task setPriority:0.5f]; [task setPriority:priorities[index]]; printf("%.2f\n", [task priority]); }
 [session invalidateAndCancel];
#endif
 return checks;
}

#ifdef NATIVE
int main(void) {
 @autoreleasepool { printf("%u\n", probe_session_task()); }
 return 0;
}
#endif
