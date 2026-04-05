// bond-ocr-helper
// Extracts text from images using Apple Vision framework (VNRecognizeTextRequest).
// Output: JSON to stdout with meta and lines.
//
// Usage:
//   bond-ocr-helper --image /path/to/image.jpg [--level accurate|fast] [--min-confidence 0.0]
//
// Frameworks: Foundation, Vision, AppKit (for NSImage/CGImage loading)

#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Parse args
        NSString *imagePath = nil;
        NSString *level = @"accurate";
        float minConfidence = 0.0;

        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--image") == 0 && i + 1 < argc) {
                imagePath = [NSString stringWithUTF8String:argv[i + 1]];
                i++;
            } else if (strcmp(argv[i], "--level") == 0 && i + 1 < argc) {
                level = [NSString stringWithUTF8String:argv[i + 1]];
                i++;
            } else if (strcmp(argv[i], "--min-confidence") == 0 && i + 1 < argc) {
                minConfidence = atof(argv[i + 1]);
                i++;
            }
        }

        if (!imagePath) {
            fprintf(stderr, "Usage: bond-ocr-helper --image <path> [--level accurate|fast] [--min-confidence 0.0]\n");
            return 1;
        }

        // Load image
        NSURL *imageURL = [NSURL fileURLWithPath:imagePath];
        CGImageSourceRef imageSource = CGImageSourceCreateWithURL((__bridge CFURLRef)imageURL, NULL);
        if (!imageSource) {
            fprintf(stderr, "Error: Could not load image at %s\n", [imagePath UTF8String]);
            return 1;
        }

        CGImageRef cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, NULL);
        CFRelease(imageSource);

        if (!cgImage) {
            fprintf(stderr, "Error: Could not create CGImage from %s\n", [imagePath UTF8String]);
            return 1;
        }

        size_t imageWidth = CGImageGetWidth(cgImage);
        size_t imageHeight = CGImageGetHeight(cgImage);

        // Set up Vision request
        __block NSMutableArray *lines = [NSMutableArray array];
        __block float totalConfidence = 0;
        __block int observationCount = 0;

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc]
            initWithCompletionHandler:^(VNRequest *request, NSError *error) {
                if (error) {
                    fprintf(stderr, "OCR error: %s\n", [[error localizedDescription] UTF8String]);
                    return;
                }

                for (VNRecognizedTextObservation *observation in request.results) {
                    VNRecognizedText *topCandidate = [[observation topCandidates:1] firstObject];
                    if (!topCandidate) continue;

                    float confidence = observation.confidence;
                    if (confidence < minConfidence) continue;

                    totalConfidence += confidence;
                    observationCount++;

                    [lines addObject:topCandidate.string];
                }
            }];

        if ([level isEqualToString:@"fast"]) {
            request.recognitionLevel = VNRequestTextRecognitionLevelFast;
        } else {
            request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        }

        request.usesLanguageCorrection = YES;

        // Perform OCR
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc]
            initWithCGImage:cgImage options:@{}];

        NSError *performError = nil;
        [handler performRequests:@[request] error:&performError];

        CGImageRelease(cgImage);

        if (performError) {
            fprintf(stderr, "OCR perform error: %s\n", [[performError localizedDescription] UTF8String]);
            return 1;
        }

        // Build output JSON
        float avgConfidence = observationCount > 0 ? totalConfidence / observationCount : 0;

        NSDictionary *meta = @{
            @"image_width": @(imageWidth),
            @"image_height": @(imageHeight),
            @"languages": @[@"en"],
            @"confidence": @(avgConfidence),
            @"observation_count": @(observationCount)
        };

        NSDictionary *output = @{
            @"meta": meta,
            @"lines": lines
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
