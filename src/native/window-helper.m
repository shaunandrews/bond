// bond-window-helper
// Lists visible on-screen windows with app name, bundle ID, title, PID, and active state.
// Output: JSON array to stdout.
//
// Usage:
//   bond-window-helper [--json] [--min-visible-area N]
//
// Frameworks: Foundation, AppKit, CoreGraphics

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Parse args
        int minVisibleArea = 0;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--min-visible-area") == 0 && i + 1 < argc) {
                minVisibleArea = atoi(argv[i + 1]);
                i++;
            }
        }

        // Get the frontmost (active) application
        NSRunningApplication *activeApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
        pid_t activePid = activeApp ? activeApp.processIdentifier : -1;

        // Get all on-screen windows
        CFArrayRef windowList = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID
        );

        if (!windowList) {
            printf("[]\n");
            return 0;
        }

        NSMutableArray *results = [NSMutableArray array];
        NSMutableSet *seenPids = [NSMutableSet set];
        NSArray *windows = (__bridge NSArray *)windowList;

        for (NSDictionary *window in windows) {
            // Skip windows that are not on screen
            NSNumber *layer = window[(__bridge NSString *)kCGWindowLayer];
            if (layer && [layer intValue] != 0) continue;

            // Get window bounds for area check
            if (minVisibleArea > 0) {
                CGRect bounds;
                NSDictionary *boundsDict = window[(__bridge NSString *)kCGWindowBounds];
                if (boundsDict) {
                    CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsDict, &bounds);
                    double area = bounds.size.width * bounds.size.height;
                    if (area < minVisibleArea) continue;
                }
            }

            NSNumber *pid = window[(__bridge NSString *)kCGWindowOwnerPID];
            NSString *ownerName = window[(__bridge NSString *)kCGWindowOwnerName];
            NSString *windowName = window[(__bridge NSString *)kCGWindowName];

            if (!pid || !ownerName) continue;

            // Skip duplicates (same PID) — keep only the first (topmost) window per app
            if ([seenPids containsObject:pid]) continue;
            [seenPids addObject:pid];

            // Get bundle ID from running application
            NSString *bundleId = @"";
            NSArray *runningApps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@""];
            // Look up by PID instead
            NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:[pid intValue]];
            if (app && app.bundleIdentifier) {
                bundleId = app.bundleIdentifier;
            }

            BOOL isActive = ([pid intValue] == activePid);

            NSDictionary *entry = @{
                @"name": ownerName ?: @"",
                @"bundleId": bundleId ?: @"",
                @"title": windowName ?: @"",
                @"active": @(isActive),
                @"pid": pid
            };
            [results addObject:entry];
        }

        CFRelease(windowList);

        // Output JSON
        NSError *error = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results
                                                           options:0
                                                             error:&error];
        if (jsonData) {
            NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
            printf("%s\n", [jsonString UTF8String]);
        } else {
            fprintf(stderr, "JSON serialization error: %s\n", [[error localizedDescription] UTF8String]);
            printf("[]\n");
            return 1;
        }
    }
    return 0;
}
