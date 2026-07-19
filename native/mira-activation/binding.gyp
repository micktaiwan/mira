{
  "targets": [
    {
      "target_name": "mira_activation",
      "sources": [ "activation.mm" ],
      "conditions": [
        [ "OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "NO",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": [ "-ObjC++" ],
            "OTHER_LDFLAGS": [
              "-framework Foundation",
              "-framework AppKit"
            ]
          }
        } ]
      ]
    }
  ]
}
