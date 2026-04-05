// bond-accessibility-helper
// Walks the AXUIElement tree for a given PID and extracts text content.
// Requires Accessibility permission (System Settings > Privacy & Security > Accessibility).
// Output: JSON to stdout with app name and structured elements.
//
// Usage:
//   bond-accessibility-helper --pid <PID> [--max-depth 10] [--types text,label,heading,value]
//
// Frameworks: Foundation, AppKit, ApplicationServices

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

// Element types we care about
static NSSet *allowedTypes = nil;

static void initAllowedTypes(NSString *typesArg) {
    if (typesArg) {
        NSArray *parts = [typesArg componentsSeparatedByString:@","];
        allowedTypes = [NSSet setWithArray:parts];
    } else {
        allowedTypes = [NSSet setWithArray:@[
            @"text", @"label", @"heading", @"value", @"title",
            @"button", @"link", @"textfield", @"textarea", @"statictext"
        ]];
    }
}

static NSString *classifyElement(AXUIElementRef element) {
    CFTypeRef roleRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &roleRef);
    if (!roleRef) return nil;

    NSString *role = (__bridge_transfer NSString *)roleRef;

    // Map AX roles to our simplified types
    if ([role isEqualToString:@"AXStaticText"]) return @"text";
    if ([role isEqualToString:@"AXTextField"]) return @"textfield";
    if ([role isEqualToString:@"AXTextArea"]) return @"textarea";
    if ([role isEqualToString:@"AXButton"]) return @"button";
    if ([role isEqualToString:@"AXLink"]) return @"link";
    if ([role isEqualToString:@"AXHeading"]) return @"heading";
    if ([role isEqualToString:@"AXMenuButton"]) return @"button";
    if ([role isEqualToString:@"AXMenuItem"]) return @"label";

    // For other roles, check if they have a title or value
    CFTypeRef titleRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute, &titleRef);
    if (titleRef) {
        CFRelease(titleRef);
        return @"label";
    }

    return nil;
}

static NSString *getElementValue(AXUIElementRef element) {
    // Try value first
    CFTypeRef valueRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXValueAttribute, &valueRef);
    if (valueRef) {
        if (CFGetTypeID(valueRef) == CFStringGetTypeID()) {
            NSString *value = (__bridge_transfer NSString *)valueRef;
            if (value.length > 0) return value;
        } else {
            CFRelease(valueRef);
        }
    }

    // Try title
    CFTypeRef titleRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute, &titleRef);
    if (titleRef) {
        if (CFGetTypeID(titleRef) == CFStringGetTypeID()) {
            NSString *title = (__bridge_transfer NSString *)titleRef;
            if (title.length > 0) return title;
        } else {
            CFRelease(titleRef);
        }
    }

    // Try description
    CFTypeRef descRef = NULL;
    AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute, &descRef);
    if (descRef) {
        if (CFGetTypeID(descRef) == CFStringGetTypeID()) {
            NSString *desc = (__bridge_transfer NSString *)descRef;
            if (desc.length > 0) return desc;
        } else {
            CFRelease(descRef);
        }
    }

    return nil;
}

static void walkElement(AXUIElementRef element, int depth, int maxDepth, NSMutableArray *results) {
    if (depth > maxDepth) return;

    // Classify this element
    NSString *type = classifyElement(element);
    if (type && [allowedTypes containsObject:type]) {
        NSString *value = getElementValue(element);
        if (value && value.length > 0) {
            // Truncate very long values
            if (value.length > 500) {
                value = [[value substringToIndex:500] stringByAppendingString:@"..."];
            }

            [results addObject:@{
                @"type": type,
                @"value": value,
                @"depth": @(depth)
            }];
        }
    }

    // Walk children
    CFTypeRef childrenRef = NULL;
    AXError err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenRef);
    if (err != kAXErrorSuccess || !childrenRef) return;

    NSArray *children = (__bridge_transfer NSArray *)childrenRef;
    for (id child in children) {
        AXUIElementRef childElement = (__bridge AXUIElementRef)child;
        walkElement(childElement, depth + 1, maxDepth, results);
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Parse args
        pid_t targetPid = 0;
        int maxDepth = 10;
        NSString *typesArg = nil;

        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--pid") == 0 && i + 1 < argc) {
                targetPid = atoi(argv[i + 1]);
                i++;
            } else if (strcmp(argv[i], "--max-depth") == 0 && i + 1 < argc) {
                maxDepth = atoi(argv[i + 1]);
                i++;
            } else if (strcmp(argv[i], "--types") == 0 && i + 1 < argc) {
                typesArg = [NSString stringWithUTF8String:argv[i + 1]];
                i++;
            }
        }

        if (targetPid == 0) {
            fprintf(stderr, "Usage: bond-accessibility-helper --pid <PID> [--max-depth 10] [--types text,label,heading,value]\n");
            return 1;
        }

        initAllowedTypes(typesArg);

        // Check if accessibility is enabled
        if (!AXIsProcessTrusted()) {
            // Output empty result with error flag
            NSDictionary *output = @{
                @"error": @"accessibility_not_trusted",
                @"message": @"Accessibility permission not granted. Enable in System Settings > Privacy & Security > Accessibility.",
                @"app": @"",
                @"pid": @(targetPid),
                @"elements": @[]
            };
            NSData *jsonData = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
            NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
            printf("%s\n", [jsonString UTF8String]);
            return 0;  // Exit cleanly so the daemon can handle the error
        }

        // Get the app name
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:targetPid];
        NSString *appName = app ? (app.localizedName ?: @"") : @"";

        // Create AXUIElement for the target process
        AXUIElementRef appElement = AXUIElementCreateApplication(targetPid);
        if (!appElement) {
            fprintf(stderr, "Error: Could not create AXUIElement for PID %d\n", targetPid);
            return 1;
        }

        // Walk the tree
        NSMutableArray *elements = [NSMutableArray array];
        walkElement(appElement, 0, maxDepth, elements);
        CFRelease(appElement);

        // Build output
        NSDictionary *output = @{
            @"app": appName,
            @"pid": @(targetPid),
            @"elements": elements
        };

        NSError *jsonError = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:output
                                                           options:0
                                                             error:&jsonError];
        if (jsonData) {
            NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
            printf("%s\n", [jsonString UTF8String]);
        } else {
            fprintf(stderr, "JSON error: %s\n", [[jsonError localizedDescription] UTF8String]);
            return 1;
        }
    }
    return 0;
}
