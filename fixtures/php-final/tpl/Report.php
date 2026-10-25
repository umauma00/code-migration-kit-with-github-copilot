<?php
// Code inside {$...} holes of "..." strings and heredocs is code; a
// nowdoc is plain text, so Plain is not a reference.
class Report {
    function sql() {
        $q = <<<SQL
SELECT {$this->col(Column::class)} FROM t WHERE k = "{$this->key["id"]}"
SQL;
        $n = <<<'TXT'
{$this->col(Plain::class)}
TXT;
        return "{$q} {${\Limit::MAX}}";
    }
}
