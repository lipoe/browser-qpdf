# Build environment for qpdf WASM image streams module
# Usage:
#   docker build -t qpdf-wasm-builder .
#   docker run --rm -v "${PWD}\dist:/out" qpdf-wasm-builder   (PowerShell)
#   docker run --rm -v "$(pwd)/dist:/out" qpdf-wasm-builder   (bash)
#
# The static libraries (zlib, libjpeg-turbo, qpdf) are built in a cached image
# layer; changes to src/ only re-run the final link step.
FROM emscripten/emsdk:3.1.74

# Install required build tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        cmake \
        make \
        patch \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /build

# qpdf is pinned to a release tag for reproducible builds
ARG QPDF_VERSION=v12.4.2
ENV QPDF_VERSION=${QPDF_VERSION}
RUN git clone --depth 1 --branch "${QPDF_VERSION}" https://github.com/qpdf/qpdf.git qpdf-src

# Dependencies: build static libraries (cached until these inputs change)
COPY build-wasm.sh ./
COPY patches/ ./patches/
COPY deps/ ./deps/

# Fix Windows CRLF line endings in all text files
# (git autocrlf on Windows converts LF to CRLF which breaks shell scripts)
RUN find . -type f \( -name '*.sh' -o -name 'configure' -o -name 'config.*' \
    -o -name 'Makefile*' -o -name '*.cmake' -o -name 'CMakeLists.txt' \
    -o -name '*.patch' -o -name '*.in' -o -name '*.ac' -o -name '*.m4' \
    -o -name '*.cpp' -o -name '*.h' -o -name '*.c' \) \
    -exec sed -i 's/\r$//' {} + && \
    chmod +x build-wasm.sh && \
    chmod +x deps/zlib/configure && \
    ./build-wasm.sh deps

# Wrapper source: only the link step depends on it
COPY src/ ./src/
RUN find src -type f \( -name '*.cpp' -o -name '*.h' \) -exec sed -i 's/\r$//' {} +

# Entry point: link the WASM module, then copy artifacts to /out volume mount.
ENTRYPOINT ["/bin/bash", "-c", "\
    ./build-wasm.sh wasm && \
    mkdir -p /out && \
    cp dist/qpdf-image-stream.js /out/ && \
    cp dist/qpdf-image-stream.wasm /out/ && \
    cp dist/build-info.json /out/ && \
    echo '=== Artifacts copied to /out ===' \
"]
