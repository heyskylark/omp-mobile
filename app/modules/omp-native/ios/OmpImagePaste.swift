import Foundation
import ObjectiveC
import UIKit

extension Notification.Name {
  static let ompPasteImages = Notification.Name("OmpNative.pasteImages")
}

/// React Native's multiline text view (`RCTUITextView`) only offers Paste when the clipboard has text.
/// This patches it so Paste also appears for an image-only clipboard, and turns that paste into an
/// `ompPasteImages` notification carrying temporary JPEG files instead of inserting anything.
enum OmpImagePaste {
  private typealias CanPerform = @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
  private typealias Paste = @convention(c) (AnyObject, Selector, AnyObject?) -> Void

  static let install: Void = {
    guard let textView = NSClassFromString("RCTUITextView"),
          let canPerform = class_getInstanceMethod(textView, #selector(UIResponder.canPerformAction(_:withSender:))),
          let paste = class_getInstanceMethod(textView, #selector(UIResponderStandardEditActions.paste(_:)))
    else {
      NSLog("OMP Mobile: RCTUITextView not found; image paste is unavailable")
      return
    }

    let originalCanPerform = unsafeBitCast(method_getImplementation(canPerform), to: CanPerform.self)
    let canPerformBlock: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = { view, action, sender in
      if originalCanPerform(view, #selector(UIResponder.canPerformAction(_:withSender:)), action, sender) { return true }
      return action == #selector(UIResponderStandardEditActions.paste(_:))
        && (view as? UITextView)?.isEditable == true
        && imageOnlyClipboard()
    }
    method_setImplementation(canPerform, imp_implementationWithBlock(canPerformBlock))

    let originalPaste = unsafeBitCast(method_getImplementation(paste), to: Paste.self)
    let pasteBlock: @convention(block) (AnyObject, AnyObject?) -> Void = { view, sender in
      guard imageOnlyClipboard() else {
        originalPaste(view, #selector(UIResponderStandardEditActions.paste(_:)), sender)
        return
      }
      let images = UIPasteboard.general.images ?? []
      let files = images.compactMap(writeTemporary)
      guard !files.isEmpty else { return }
      NotificationCenter.default.post(name: .ompPasteImages, object: nil, userInfo: ["images": files])
    }
    method_setImplementation(paste, imp_implementationWithBlock(pasteBlock))
  }()

  // `has*` checks do not trigger the iOS paste permission prompt; reading the image happens inside the user's paste.
  private static func imageOnlyClipboard() -> Bool {
    UIPasteboard.general.hasImages && !UIPasteboard.general.hasStrings && !UIPasteboard.general.hasURLs
  }

  private static func writeTemporary(_ image: UIImage) -> [String: Any]? {
    guard let data = image.jpegData(compressionQuality: 0.95) else { return nil }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("paste-\(UUID().uuidString).jpg")
    do {
      try data.write(to: url)
    } catch {
      NSLog("OMP Mobile: could not save pasted image: %@", error.localizedDescription)
      return nil
    }
    return [
      "uri": url.absoluteString,
      "width": Double(image.size.width * image.scale),
      "height": Double(image.size.height * image.scale),
    ]
  }
}
