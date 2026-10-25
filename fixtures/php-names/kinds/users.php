<?php
// Real class uses: new, ::, a parameter type.
function pk_use(PkView $v) { return new PkDebug() ?: Date::today(); }
