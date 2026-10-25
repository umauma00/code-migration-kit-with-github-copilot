<?php
preg_replace_callback_array(['/x/' => 'n_transform'], 'x');
session_set_save_handler('n_open', 'n_close', 'n_read', 'n_write', 'n_destroy', 'n_gc', 'n_create_sid', 'n_validate_sid', 'n_update_timestamp');
