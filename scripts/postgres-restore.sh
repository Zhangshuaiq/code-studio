#!/usr/bin/env sh
set -eu

backup_file="${1:-}"
container="${POSTGRES_CONTAINER:-codegen-postgres}"
database="${POSTGRES_DB:-codegen}"
user="${POSTGRES_USER:-codegen}"

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
  echo "用法: RESTORE_CONFIRM=<数据库名> $0 <backup.dump>" >&2
  exit 1
fi
if [ "${RESTORE_CONFIRM:-}" != "$database" ]; then
  echo "恢复会覆盖数据库。请设置 RESTORE_CONFIRM=$database 后重试。" >&2
  exit 1
fi
if [ ! -f "$backup_file.manifest" ]; then
  echo "缺少备份清单: $backup_file.manifest" >&2
  exit 1
fi

expected="$(awk -F= '$1 == "sha256" { print $2 }' "$backup_file.manifest")"
actual="$(file_sha256 "$backup_file")"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "备份校验失败，拒绝恢复" >&2
  exit 1
fi

docker exec -i "$container" pg_restore \
  --username "$user" \
  --dbname "$database" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error <"$backup_file"

echo "数据库恢复完成: $database"
