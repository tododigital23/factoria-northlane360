# API de La Factoría. Railway despliega este fichero si el servicio
# no tiene Root Directory = servidor.
FROM python:3.12-slim
WORKDIR /app
COPY servidor/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY servidor/app ./app
COPY servidor/ops ./ops
COPY servidor/db ./db
COPY servidor/ops/start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 8000
CMD ["/start.sh"]
