<?php
preg_replace_callback_array(
    pattern: ['/x/' => 'n_transform'],
    subject: 'x',
);
session_set_save_handler(open: 'n_open', close: 'n_close', read: 'n_read', write: 'n_write', destroy: 'n_destroy', gc: 'n_gc', create_sid: 'n_create_sid', validate_sid: 'n_validate_sid', update_timestamp: 'n_update_timestamp');
