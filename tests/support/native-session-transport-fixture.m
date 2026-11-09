#import <Foundation/Foundation.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *);

static char events[2048];
static volatile int invalidated;
static int mode;
static pthread_t caller;

static void note(const char *text) { strcat(events, text); strcat(events, ";"); }
static NSString *text(const char *value) { return [NSString stringWithUTF8String:value]; }

static void onSent(id self, SEL command, NSURLSession *session, NSURLSessionTask *task, int64_t sent, int64_t total, int64_t expected) {
 char line[96]; snprintf(line, sizeof line, "sent %lld %lld %lld", (long long)sent, (long long)total, (long long)expected); note(line);
}

static void onResponse(id self, SEL command, NSURLSession *session, NSURLSessionDataTask *task, NSURLResponse *response, void (^handler)(NSURLSessionResponseDisposition)) {
 NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
 NSString *value = [[http allHeaderFields] objectForKey:text("x-probe")];
 char line[160]; snprintf(line, sizeof line, "response %ld %lld %s caller=%d", (long)[http statusCode], (long long)[response expectedContentLength], value ? [value UTF8String] : "none", pthread_equal(pthread_self(), caller) != 0); note(line);
 handler(mode == 1 ? NSURLSessionResponseCancel : NSURLSessionResponseAllow);
}

static void onData(id self, SEL command, NSURLSession *session, NSURLSessionDataTask *task, NSData *data) {
 char body[64], line[96]; size_t length = [data length] < 63 ? [data length] : 63; memcpy(body, [data bytes], length); body[length] = 0;
 snprintf(line, sizeof line, "data %lu %s", (unsigned long)[data length], body); note(line);
}

static void onComplete(id self, SEL command, NSURLSession *session, NSURLSessionTask *task, NSError *error) {
 char line[64]; if (error) snprintf(line, sizeof line, "complete %ld", (long)[error code]); else snprintf(line, sizeof line, "complete ok"); note(line);
}

static void onInvalid(id self, SEL command, NSURLSession *session, NSError *error) { note(error ? "invalid error" : "invalid"); invalidated = 1; }

const char *probe_transport(const char *address, int requestMode) {
 events[0] = 0; invalidated = 0; mode = requestMode; caller = pthread_self();
 Class type = objc_getClass("TransportProbe");
 if (!type) {
  type = objc_allocateClassPair([NSObject class], "TransportProbe", 0);
  class_addMethod(type, sel_registerName("URLSession:task:didSendBodyData:totalBytesSent:totalBytesExpectedToSend:"), (IMP)onSent, "v@:@@qqq");
  class_addMethod(type, sel_registerName("URLSession:dataTask:didReceiveResponse:completionHandler:"), (IMP)onResponse, "v@:@@@@?");
  class_addMethod(type, sel_registerName("URLSession:dataTask:didReceiveData:"), (IMP)onData, "v@:@@@");
  class_addMethod(type, sel_registerName("URLSession:task:didCompleteWithError:"), (IMP)onComplete, "v@:@@@");
  class_addMethod(type, sel_registerName("URLSession:didBecomeInvalidWithError:"), (IMP)onInvalid, "v@:@@");
  objc_registerClassPair(type);
 }
 id delegate = [[type alloc] init];
 void *pool = objc_autoreleasePoolPush();
 NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
 NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:delegate delegateQueue:nil];
 NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:text(address)]];
 if (mode == 2) { [request setHTTPMethod:text("POST")]; [request setHTTPBody:[NSData dataWithBytes:"abc" length:3]]; }
 NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
 [task retain]; [task resume]; [session finishTasksAndInvalidate];
 struct timespec interval = { 0, 1000000 };
 for (int waited = 0; !invalidated && waited < 8000; waited++) nanosleep(&interval, 0);
 char line[32]; snprintf(line, sizeof line, "state %ld", (long)[task state]); note(line);
 [task release];
 objc_autoreleasePoolPop(pool);
 [delegate release];
 return events;
}

#ifdef NATIVE
int main(int count, char **values) { puts(probe_transport(values[1], values[2][0] - '0')); return 0; }
#endif
