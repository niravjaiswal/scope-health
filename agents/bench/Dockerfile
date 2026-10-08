FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pip install --no-cache-dir playwright==1.63.0 httpx==0.28.1 && playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY *.py /app/
CMD ["python", "-u", "/app/bench.py"]
