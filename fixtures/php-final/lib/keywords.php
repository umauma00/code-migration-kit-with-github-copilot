<?php
// match (...) and yield from are keywords here, not the classes.
function gen() { yield from [1]; }
$r = match (1) { 1 => 'one', default => 'other' };
