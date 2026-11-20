-- Fixture: depends on the items folder, so it only applies if folders run in the order given.
create table fx.tag (item_id uuid not null references fx.item (id), tag text not null);
