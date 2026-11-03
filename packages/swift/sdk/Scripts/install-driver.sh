#!/bin/sh
set -eu
swift build --jobs 4 --enable-code-coverage --product SemiontWireDriver
bin=$(swift build --show-bin-path)
mkdir -p .build/conformance/bin .build/conformance/lib
cp "$bin/SemiontWireDriver" .build/conformance/bin/
# The suite's Ubuntu runner supplies libc and curl; Swift's runtime travels with the driver.
ldd "$bin/SemiontWireDriver" | awk '$2 == "=>" && $3 ~ /\/swift\// { print $3 }' > .build/driver-libraries
while IFS= read -r library; do cp "$library" .build/conformance/lib/; done < .build/driver-libraries
cp Conformance/launch.sh .build/conformance/semiont-swift-wire-driver
chmod +x .build/conformance/semiont-swift-wire-driver
