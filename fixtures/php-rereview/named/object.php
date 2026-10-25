<?php
session_set_save_handler(new NHandler(), true);
session_set_save_handler($handler, true);
