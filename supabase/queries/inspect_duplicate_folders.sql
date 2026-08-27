-- 읽기 전용 점검 쿼리. 아무것도 변경하지 않는다.
-- 정리 마이그레이션을 실행하기 전에 무엇이 남고 무엇이 지워지는지 먼저 확인한다.

-- 1) 중복된 폴더 경로와 개수
select user_id, path, count(*) as row_count
from folders
group by user_id, path
having count(*) > 1
order by row_count desc, path;

-- 2) 행 단위로 "남길 것 / 지울 것" 미리보기
--    같은 (user_id, path) 그룹에서 id가 가장 작은 행만 남는다.
with ranked as (
  select
    id, user_id, name, path, parent_id,
    row_number() over (partition by user_id, path order by id) as rn,
    count(*)     over (partition by user_id, path)             as dup_count
  from folders
)
select
  case when rn = 1 then 'KEEP' else 'DELETE' end as action,
  path, id, name, parent_id, rn, dup_count
from ranked
where dup_count > 1
order by path, rn;

-- 3) 노트는 folders 행을 id로 참조하지 않는다 (notes.folder = 경로 문자열).
--    따라서 중복 폴더 행 삭제로 사라지는 노트는 없다. 아래로 확인:
--    각 경로에 붙은 노트 수는 남는 행 1개에 그대로 유지된다.
select n.folder as path, count(*) as note_count
from notes n
where n.folder is not null
  and (n.user_id, n.folder) in (
    select user_id, path from folders group by user_id, path having count(*) > 1
  )
group by n.folder
order by n.folder;

-- 4) 이미 폴더 행이 없는 노트(=기존 orphan). 마이그레이션은 이 수치가
--    "늘어나지 않는지"를 검증하고, 늘어나면 스스로 롤백한다.
select count(*) as orphan_notes_before
from notes n
where n.folder is not null
  and not exists (
    select 1 from folders f where f.user_id = n.user_id and f.path = n.folder
  );
