<?php
// Array keys and plain words are not references, even when they equal a
// class or function name.
$row = ['order' => 1, 'status' => 2];
echo $row['order'], 'status';
