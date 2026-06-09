import 'package:flutter_test/flutter_test.dart';

import 'package:nexio_mobile/main.dart';

void main() {
  testWidgets('App renders home screen', (WidgetTester tester) async {
    await tester.pumpWidget(const NexioApp());
    expect(find.text('Nexio Setup'), findsOneWidget);
  });
}
