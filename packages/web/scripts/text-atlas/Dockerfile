# msdf-atlas-gen (Chlumsky), built from a pinned tag, for
# packages/web/scripts/generate-text-atlas.ts (docs/map-rendering.md §4.10).
# A throwaway tool image: it is never part of the app images.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git cmake make g++ libfreetype-dev libpng-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
# v1.4 = 2ede254314a2512252a225fa6c975948d6af559a
RUN git clone --branch v1.4 --recurse-submodules --shallow-submodules --depth 1 https://github.com/Chlumsky/msdf-atlas-gen /src \
 && test "$(git -C /src rev-parse HEAD)" = 2ede254314a2512252a225fa6c975948d6af559a
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DMSDF_ATLAS_USE_VCPKG=OFF -DMSDF_ATLAS_USE_SKIA=OFF -DMSDF_ATLAS_NO_ARTERY_FONT=ON -DMSDFGEN_DISABLE_SVG=ON \
 && cmake --build /build -j"$(nproc)" \
 && cp "$(find /build -type f -name msdf-atlas-gen -perm -u+x | head -1)" /usr/local/bin/msdf-atlas-gen
ENTRYPOINT ["/usr/local/bin/msdf-atlas-gen"]
