import 'package:flutter/material.dart';
import 'screens/home_screen.dart';

void main() {
  runApp(const NexioApp());
}

class NexioApp extends StatelessWidget {
  const NexioApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nexio',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
