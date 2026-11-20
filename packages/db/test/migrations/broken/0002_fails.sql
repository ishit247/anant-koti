-- Fixture: the first statement succeeds, the second fails, so the whole file must leave no trace.
create table broken_partial (id int);
select * from no_such_table;
