# UMSC-CPP

`UMSC-CPP` is a C++ Uyghur multi-script conversion library. It is based on the same CTS-centered design as the original Python version: source text is first normalized into Common Turkic Script (`CTS`), then converted to the target script.

This C++ implementation is derived from the original `umsc` Python project by Osman Tursun (`neouyghur`). The core conversion logic, script naming, and mapping design come from that original Python implementation and its published package metadata.

Original project attribution:

- Original author: Osman Tursun
- Original Python package: `umsc`
- Published source reference: PyPI package description and original Python implementation
- Original GitHub repository: https://github.com/neouyghur/Uyghur-Multi-Script-Converter/tree/master
- Current C++ port: `UMSC-CPP`

The library currently supports the main Uyghur script forms used in the original project, including:

- `UAS` : Uyghur Arabic Script
- `ULS` : Uyghur Latin Script
- `UYS` : Uyghur Yengi Script
- `UCS` : Uyghur Cyrillic Script
- `CTS` : Common Turkic Script
- `XJUS` : Xinjiang University style
- `UZLS` : Uzbek Latin Script
- `IPA` : IPA output from `CTS`

Input and output text should be UTF-8 encoded.

## Background

The original Python project describes this converter as a script converter for Uyghur language text and supports these writing systems:

- `ULS` : Uyghur Latin Script
- `UAS` : Uyghur Arabic Script
- `CTS` : Common Turkish / Turkic Script
- `UCS` : Uyghur Cyrillic Script
- `UYS` : Uyghur Yengi Script
- `IPA` : International Phonetic Alphabet
- `UZLS` : Uzbek Latin Script
- `XJUS` : Xinjiang University Script

Like the original version, this port is intended to keep the implementation simple and easy to extend, even when some conversions pass through `CTS` as an intermediate form.

## Use As A Library

If this repository is included with `add_subdirectory`, link your target against `UMSC-CPP`:

```cmake
add_subdirectory(UMSC-CPP)

target_link_libraries(your_target PRIVATE UMSC-CPP)
```

The public header is:

```cpp
#include "umsc.h"
```

Minimal example:

```cpp
#include "umsc.h"
#include <iostream>

int main() {
    umsc converter("UAS", "ULS");
    std::string result = converter.convert(u8"سالام");
    std::cout << result << '\n';
    return 0;
}
```

You can also set scripts per conversion call:

```cpp
#include "umsc.h"

int main() {
    umsc converter;
    std::string result = converter.convert(u8"shang", "ULS", "CTS");
}
```

## Notes

- Not every possible source and target combination is implemented.
- Most conversions go through `CTS`, matching the original Python implementation.
- Some mappings, especially less common paths such as Uzbek-related conversions, may still need refinement.
