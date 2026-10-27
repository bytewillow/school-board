FROM python:3.12-slim
WORKDIR /app
COPY app.py icon-192.png icon-512.png apple-touch-icon.png icon.svg manifest.json sw.js /app/
COPY static /app/static
ENV DATA_DIR=/data PORT=8765
VOLUME /data
EXPOSE 8765
CMD ["python3", "app.py"]
