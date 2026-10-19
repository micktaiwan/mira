{
  # Built only through build.mjs, which skips the build when libkova.a is
  # missing or of another arch. The path comes from lib-path.cjs (KOVA_LIB >
  # $CARGO_TARGET_DIR/release > ~/.cargo/target/release).
  "variables": {
    "kova_lib%": "<!(node lib-path.cjs)"
  },
  "targets": [
    {
      "target_name": "mira_kova",
      "sources": [ "kova.mm" ],
      "conditions": [
        [ "OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "NO",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": [ "-ObjC++" ],
            "OTHER_LDFLAGS": [
              "<(kova_lib)",
              "-framework UserNotifications",
              "-framework AppKit",
              "-framework CoreData",
              "-framework CoreText",
              "-framework CoreImage",
              "-framework CloudKit",
              "-framework QuartzCore",
              "-framework CoreVideo",
              "-framework CoreGraphics",
              "-framework Metal",
              "-framework Foundation",
              "-framework CoreFoundation",
              "-liconv",
              "-lobjc"
            ]
          }
        } ]
      ]
    }
  ]
}
