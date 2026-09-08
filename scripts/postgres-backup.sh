#!/usr/bin/env sh
set -eu

backup_dir="${BACKUP_DIR:-.data/backups/postgres}"
container="${POSTGRES_CONTAINER:-codegen-postgres}"
database="${POSTGRES_DB:-codegen}"
user="${POSTGRES_USER:-codegen}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
backup_file="$backup_dir/${database}-${timestamp}.dump"

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if ! docker inspect "$container" >/dev/null 2>&1; then
  echo "PostgreSQL 容器不存在: $container" >&2
  exit 1
fi

echo "正在备份数据库 $database ..."
if ! docker exec "$container" pg_dump \
  --username "$user" \
  --dbname "$database" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges >"$backup_file"; then
  rm -f "$backup_file"
  echo "数据库备份失败" >&2
  exit 1
fi

docker exec -i "$container" pg_restore --list <"$backup_file" >/dev/null
checksum="$(file_sha256 "$backup_file")"
size="$(wc -c <"$backup_file" | tr -d ' ')"
manifest="$backup_file.manifest"
{
  echo "database=$database"
  echo "created_at=$timestamp"
  echo "sha256=$checksum"
  echo "size_bytes=$size"
} >"$manifest"

echo "备份完成: $backup_file"
echo "校验文件: $manifest"
