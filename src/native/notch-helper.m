// bond-notch-helper
// Reports per-display notch and menu-bar geometry.
//
// Electron exposes none of this: `screen.getPrimaryDisplay()` has no
// safeAreaInsets, no auxiliaryTopLeftArea, no safe-area field of any name, and
// electron#31478 asked for exactly that and was closed not-planned. CSS
// env(safe-area-inset-top) returns 0px — Chromium only wires it on iOS/Android.
//
// The notch is a fixed number of PHYSICAL pixels, so its point size scales with
// framebuffer width. Never hardcode a table; ask the system.
//
// Match a display to an Electron `Display.id` via NSScreenNumber — on macOS
// Electron's Display.id IS the CGDirectDisplayID.
//
// Output: JSON array to stdout. Requires macOS 12+.
//
// Frameworks: Foundation, AppKit

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
    (void)argc; (void)argv;
    @autoreleasepool {
        NSMutableArray *results = [NSMutableArray array];

        for (NSScreen *screen in [NSScreen screens]) {
            NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
            if (!screenNumber) continue;

            NSRect frame = screen.frame;
            NSRect visible = screen.visibleFrame;

            // Menu bar height from the frame/visibleFrame delta at the TOP.
            // Never `frame.height - visibleFrame.height` — that silently
            // includes the Dock whenever the Dock is at the bottom.
            CGFloat menuBarHeight = NSMaxY(frame) - NSMaxY(visible);
            if (menuBarHeight < 0) menuBarHeight = 0;

            CGFloat notchWidth = 0;
            CGFloat notchHeight = 0;
            BOOL notched = NO;

            if (@available(macOS 12.0, *)) {
                NSEdgeInsets insets = screen.safeAreaInsets;
                // On the macOS 26 SDK these are plain NSRect properties, not
                // the nullable NSValue * the older headers (and most sample
                // code) declare. A non-notched display reports empty rects, so
                // width is the presence test rather than nil.
                NSRect left = screen.auxiliaryTopLeftArea;
                NSRect right = screen.auxiliaryTopRightArea;

                if (insets.top > 0 && left.size.width > 0 && right.size.width > 0) {
                    // The notch is what the two auxiliary areas do not cover.
                    notchWidth = frame.size.width - left.size.width - right.size.width;
                    notchHeight = insets.top;
                    notched = (notchWidth > 0);
                }
            }

            NSDictionary *entry = @{
                @"displayId": @([screenNumber unsignedIntValue]),
                @"notched": @(notched),
                @"notchWidth": @(notched ? notchWidth : 0),
                @"notchHeight": @(notched ? notchHeight : 0),
                @"menuBarHeight": @(menuBarHeight),
                @"frame": @{
                    @"x": @(frame.origin.x),
                    @"y": @(frame.origin.y),
                    @"width": @(frame.size.width),
                    @"height": @(frame.size.height)
                },
                @"backingScaleFactor": @(screen.backingScaleFactor)
            };
            [results addObject:entry];
        }

        NSError *error = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results options:0 error:&error];
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
