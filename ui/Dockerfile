FROM python:3.12-slim

# ffmpeg/ffprobe: segment durations for the HLS playlist + on-demand MP4 export.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

# Container clock is UTC by default, matching the telemetry unix-ms timeline.
EXPOSE 8080
# --no-access-log: HLS playback issues one GET per segment per viewer and the
# tree is polled every 30 s per open tab, so access logging is the loudest
# writer on a host we share with other workloads.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--no-access-log", "--limit-concurrency", "64"]
