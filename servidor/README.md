# Servidor de La Factoría Northlane360

Python + FastAPI. La explicación completa está en el `README.md` de la carpeta superior.

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
python -m pytest tests -q
```

- `app/` — el código. Cada archivo empieza explicando qué hace y qué no puede hacer.
- `db/eliot/` — la base de datos, migración a migración. `base/` son los cimientos.
- `conector/` — la pieza que se instala en la web de cada empresa (`LEEME.md`).
- `ops/` — instalación del esquema (`install_schema.py`) y migraciones controladas.
- La URL de la base es `DATABASE_URL` (Postgres, MySQL, MariaDB, SQLite o SQL Server).
- `scripts/local_pg_pipeline.sh` — batería de base de datos sobre una base desechable.
