FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright WF_DOC_FONTS=/app/doc_fonts PROBES=3 DIAG_NOROWS=1
RUN pip install --no-cache-dir playwright==1.63.0 httpx==0.28.1 fonttools brotli pillow pymupdf && \
    playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/* /root/.cache
WORKDIR /app
COPY doc_fonts /app/doc_fonts
COPY sr /app/sr
RUN python -c "import sr.wf_docs as w; w.load_reference(); print('ref ok')"
CMD ["python", "-u", "-m", "sr.main"]
