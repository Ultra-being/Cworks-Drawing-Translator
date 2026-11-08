FROM python:3.12-slim

# fonts for previews (Latin, CJK) and build tools for the wheels that need them
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-dejavu-core fonts-noto-cjk fontconfig curl tzdata \
    && rm -rf /var/lib/apt/lists/*

# The people reading these timestamps are in Tokyo. The server would otherwise
# run on UTC and stamp every job nine hours behind the office, which reads as
# a mistake rather than as a timezone. Set here so the job list, the report
# and the usage log all agree, instead of converting in each place and
# missing one. tzdata is installed above because the slim image carries no
# timezone database and TZ on its own would do nothing.
ENV TZ=Asia/Tokyo

# ── DWG, through the ODA File Converter ──
#
# Clients send DWG and ezdxf reads only DXF, so the drawing is converted on
# the way in and back again on the way out. The converter is a free download
# from the Open Design Alliance; the URL carries no version number and
# redirects to whatever the current release is, so this does not need bumping.
#
# Xvfb is here because the converter is a windowed program even when it is
# only converting a file, and on a server there is no screen to open a window
# on. ezdxf starts Xvfb to give it one.
#
# A failure to fetch it does not fail the build. One deploy of an unrelated
# fix should not be blocked by somebody else's download, and the app already
# copes: DWG uploads are refused with a message telling staff to export a
# DXF, and /healthz reports "dwg": false so it can be seen from outside.
ARG ODA_DEB_URL="https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_lnxX64_11dll.deb"
RUN set -u; ok=0; \
    if [ -n "$ODA_DEB_URL" ]; then \
      apt-get update \
        && curl -fsSL --retry 3 --retry-delay 5 -o /tmp/oda.deb "$ODA_DEB_URL" \
        && dpkg-deb -I /tmp/oda.deb > /dev/null \
        && apt-get install -y --no-install-recommends xvfb /tmp/oda.deb \
        && ok=1; \
      rm -f /tmp/oda.deb; rm -rf /var/lib/apt/lists/*; \
    fi; \
    if [ "$ok" = 1 ]; then \
      echo "ODA File Converter installed at $(command -v ODAFileConverter || echo '(not on PATH -- set DXFT_ODAFC)')"; \
    else \
      echo "WARNING: no ODA File Converter in this image. DWG uploads will be refused with a"; \
      echo "         message asking for a DXF, and /healthz will report \"dwg\": false."; \
    fi

WORKDIR /app
COPY pyproject.toml README.md HOW_TO_USE.md TROUBLESHOOTING.md ./
COPY src ./src
COPY workspaces ./workspaces
RUN pip install --no-cache-dir . && fc-cache -f || true

# writable caches; jobs live on the mounted disk
ENV MPLCONFIGDIR=/tmp/mpl XDG_CACHE_HOME=/tmp/cache DXFT_WORKSPACES=/app/workspaces DXFT_GUIDES=/app PORT=10000
RUN mkdir -p /data/jobs /tmp/mpl /tmp/cache

EXPOSE 10000
HEALTHCHECK --interval=60s --timeout=5s CMD curl -fs http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["sh", "-c", "dxft --jobs /data/jobs serve --host 0.0.0.0 --port ${PORT}"]
