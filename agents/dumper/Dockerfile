FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pip install --no-cache-dir playwright==1.63.0 && playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY wfcrawl.py dumper.py set1_lastnames.json /app/
ENV ONLY_VERSION=4.3.1 NPAGES=8 CRAWL_FRAC=0.88
CMD ["python", "-u", "/app/dumper.py"]
