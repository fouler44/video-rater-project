alter table lists
  add column if not exists list_source text not null default 'mal';

alter table lists
  drop constraint if exists lists_list_source_check;

alter table lists
  add constraint lists_list_source_check
  check (list_source in ('mal', 'youtube'));

update lists
set list_source = 'mal'
where list_source is null or trim(list_source) = '';
