<?php
function run_cb($event, $class) {
    call_user_func("handle_$event");
    call_user_func("handle_{$event}");
    call_user_func('plain_$x');
    call_user_func("esc_\$x");
    call_user_func(<<<EOT
h_$event
EOT
);
    call_user_func(<<<'EOT'
nowdoc_cb
EOT
);
    call_user_func([$class, 'run']);
    call_user_func(array($class, 'run'));
    call_user_func([$this, 'run']);
    call_user_func(['KnownCb', 'run']);
    call_user_func([KnownCb::class, 'run']);
    call_user_func([self::class, 'run']);
    array_map(null, [1, 2]);
    array_filter([0, 1], null);
    $f = call_user_func(...);
    call_user_func(...$args);
}
class Own {
    function hooks() {
        add_action('init', array(&$this, 'run'));
        add_action('init', array(__CLASS__, 'run'));
        add_action('init', array($skin, 'feedback'));
    }
}
