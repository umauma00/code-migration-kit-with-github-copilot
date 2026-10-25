<html><body><?php
require_once __DIR__ . '/config.php';
require_once dirname(__FILE__) . '/lib/functions.php';
include 'legacy/old_report.php';
include $pluginDir . '/plugin.php';
require_once APP_ROOT . '/lib/db.php';

use App\Services\OrderService;
use App\Models\{Order, Customer as Client};

// new Invoice() in a comment is not a reference
$service = new OrderService();
$client = new Client();
$class = 'App\Models\Invoice';
$obj = new $class();
echo format_price(10), SITE_NAME;
?>
<p>Order and Customer in HTML are not code.</p>
</body></html>
