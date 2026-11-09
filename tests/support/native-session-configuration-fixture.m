#import <Foundation/Foundation.h>
#include <stdio.h>
#include <math.h>

unsigned probe_session_configuration(void) {
 unsigned checks = 0;
 NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
 NSURLSessionConfiguration *second = [NSURLSessionConfiguration defaultSessionConfiguration];
 if (configuration != second && [configuration identifier] == nil) checks |= 1;
 if ([configuration timeoutIntervalForRequest] == 60 && [configuration timeoutIntervalForResource] == 604800) checks |= 2;
 if ([configuration requestCachePolicy] == 0 && [configuration networkServiceType] == 0) checks |= 4;
 if ([configuration allowsCellularAccess] && ![configuration isDiscretionary] && ![configuration HTTPShouldUsePipelining] && [configuration HTTPShouldSetCookies]) checks |= 8;
 if ([configuration HTTPMaximumConnectionsPerHost] == 6 && [configuration HTTPCookieAcceptPolicy] == 2) checks |= 16;
 [configuration setTimeoutIntervalForRequest:2.75]; [configuration setTimeoutIntervalForResource:7.125];
 [configuration setHTTPMaximumConnectionsPerHost:1]; [configuration setRequestCachePolicy:1];
 [configuration setAllowsCellularAccess:NO]; [configuration setDiscretionary:YES];
 [configuration setHTTPShouldUsePipelining:YES]; [configuration setHTTPShouldSetCookies:NO];
 [configuration setHTTPCookieAcceptPolicy:1]; [configuration setNetworkServiceType:2];
 NSURLSessionConfiguration *copy = [configuration copy];
 if ([copy timeoutIntervalForRequest] == 2.75 && [copy timeoutIntervalForResource] == 7.125 && [copy HTTPMaximumConnectionsPerHost] == 1 && [copy requestCachePolicy] == 1) checks |= 32;
 if (![copy allowsCellularAccess] && [copy isDiscretionary] && [copy HTTPShouldUsePipelining] && ![copy HTTPShouldSetCookies] && [copy HTTPCookieAcceptPolicy] == 1 && [copy networkServiceType] == 2) checks |= 64;
 [configuration setTimeoutIntervalForRequest:0]; [configuration setHTTPMaximumConnectionsPerHost:3];
 if ([copy timeoutIntervalForRequest] == 2.75 && [copy HTTPMaximumConnectionsPerHost] == 1 && [second timeoutIntervalForRequest] == 60 && [second HTTPMaximumConnectionsPerHost] == 6) checks |= 128;
 [copy release];
 [configuration setTimeoutIntervalForRequest:-1]; [configuration setTimeoutIntervalForResource:-1];
 if ([configuration timeoutIntervalForRequest] == -1 && [configuration timeoutIntervalForResource] == -1) checks |= 256;
 [configuration setTimeoutIntervalForRequest:INFINITY]; [configuration setTimeoutIntervalForResource:NAN];
 double resourceTimeout = [configuration timeoutIntervalForResource];
 if ([configuration timeoutIntervalForRequest] == INFINITY && resourceTimeout != resourceTimeout) checks |= 512;
 return checks;
}

#ifdef NATIVE
int main(void) {
 @autoreleasepool {
  printf("%u\n", probe_session_configuration());
  NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
  printf("%d %d %d %d %d\n", [configuration sessionSendsLaunchEvents], [configuration waitsForConnectivity], [configuration allowsExpensiveNetworkAccess], [configuration allowsConstrainedNetworkAccess], [configuration shouldUseExtendedBackgroundIdleMode]);
  for (double value = -1; value <= 1; value++) {
   [configuration setTimeoutIntervalForRequest:value]; [configuration setTimeoutIntervalForResource:value];
   printf("%.1f %.1f\n", [configuration timeoutIntervalForRequest], [configuration timeoutIntervalForResource]);
  }
 }
 return 0;
}
#endif
