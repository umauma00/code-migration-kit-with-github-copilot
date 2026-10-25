<?php
// From sub/, ../helper.php is helper.php whatever the working directory
// (sub/ or --root gives the same single file).
require_once '../helper.php';
// ./part.php is sub/part.php when run from sub/, part.php when run from
// --root: both become edges and the include is listed as unresolved.
include './part.php';
