<?php
mb_ereg_replace_callback('x', 'cb1', $s);
stream_wrapper_register('x', 'Wrap');
xml_set_element_handler($p, 'st', 'en');
$r = new ReflectionClass('Refl');
$m = new ReflectionMethod('Refm::go');
$n = new \ReflectionMethod(objectOrMethod: 'Refn');
xml_set_element_handler($p, false, false);
