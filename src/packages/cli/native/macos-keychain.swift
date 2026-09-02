import Foundation
import Security

func item(service: String, account: String) -> (OSStatus, SecKeychainItem?) {
  var found: SecKeychainItem?
  let status = service.withCString { serviceBytes in
    account.withCString { accountBytes in
      SecKeychainFindGenericPassword(
        nil,
        UInt32(strlen(serviceBytes)), serviceBytes,
        UInt32(strlen(accountBytes)), accountBytes,
        nil, nil, &found
      )
    }
  }
  return (status, found)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { exit(64) }
let operation = arguments[1]
let service = arguments[2]

if operation == "availability" {
  var keychain: SecKeychain?
  exit(SecKeychainCopyDefault(&keychain) == errSecSuccess ? 0 : 1)
}

guard arguments.count >= 4 else { exit(64) }
let account = arguments[3]

if operation == "resolve" {
  var length: UInt32 = 0
  var value: UnsafeMutableRawPointer?
  let status = service.withCString { serviceBytes in
    account.withCString { accountBytes in
      SecKeychainFindGenericPassword(
        nil,
        UInt32(strlen(serviceBytes)), serviceBytes,
        UInt32(strlen(accountBytes)), accountBytes,
        &length, &value, nil
      )
    }
  }
  guard status == errSecSuccess, let value else { exit(1) }
  FileHandle.standardOutput.write(Data(bytes: value, count: Int(length)))
  SecKeychainItemFreeContent(nil, value)
  exit(0)
}

let secret = FileHandle.standardInput.readDataToEndOfFile()
guard !secret.isEmpty else { exit(65) }

if operation == "create" {
  let status = service.withCString { serviceBytes in
    account.withCString { accountBytes in
      secret.withUnsafeBytes { secretBytes in
        SecKeychainAddGenericPassword(
          nil,
          UInt32(strlen(serviceBytes)), serviceBytes,
          UInt32(strlen(accountBytes)), accountBytes,
          UInt32(secret.count), secretBytes.baseAddress!,
          nil
        )
      }
    }
  }
  exit(status == errSecSuccess ? 0 : 1)
}

if operation == "update" {
  let (found, keychainItem) = item(service: service, account: account)
  guard found == errSecSuccess, let keychainItem else { exit(1) }
  let status = secret.withUnsafeBytes {
    SecKeychainItemModifyAttributesAndData(keychainItem, nil, UInt32(secret.count), $0.baseAddress)
  }
  exit(status == errSecSuccess ? 0 : 1)
}

exit(64)
