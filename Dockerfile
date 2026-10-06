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
