alter table ratings
  alter column score type numeric(3,1) using score::numeric(3,1);

alter table ratings
  drop constraint if exists ratings_score_check;

alter table ratings
  add constraint ratings_score_check
  check (score between 1 and 10 and mod(score * 10, 5) = 0);
